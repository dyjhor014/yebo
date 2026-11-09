import { Injectable } from '@nestjs/common';
import type { HubInvitationAccepted, HubInvitationPreview } from '@yebo/contracts';
import { AppError } from '../../common/errors/app-error';
import { Prisma } from '../../generated/prisma/client';
import { isOperationAllowed, tenantPhase } from '../access/tenant-operation';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { Clock } from './clock';
import { IdentityPrismaService } from './identity-prisma.service';
import { parseInvitationToken } from './invitation-token';
import { PasswordHasher } from './password-hasher';
import { passwordProblem } from './password-policy';
import { RateLimiterService } from './rate-limiter.service';
import { SessionService } from './session.service';

/** Intentos por IP en las rutas de invitación (vista previa, aceptar, crear cuenta) cada 15 minutos. */
export const INVITATION_LIMITS = { perIp: 30, windowSeconds: 900 } as const;

/** Respuesta ÚNICA para token mal formado, inexistente, caducado, revocado o ya usado. */
const INVALID = (): AppError =>
  new AppError('NOT_FOUND', 'Esta invitación no es válida, caducó o ya se usó', 404);
const TOO_MANY = (): AppError =>
  new AppError('RATE_LIMITED', 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo', 429);

type Parsed = NonNullable<ReturnType<typeof parseInvitationToken>>;
type Who =
  { userId: string; email: string } | { newUser: { email: string; fullName: string; passwordHash: string } };

/**
 * Aceptación de invitaciones en el hub (Fase 4.3b; multitenancy §1.1; decisiones del 2026-11-10). Rol `yebo_identity`,
 * siempre con el contexto del tenant de la invitación fijado (RLS): el id del tenant viaja en el token.
 *
 * - Con sesión del hub: la persona acepta si su correo es el de la invitación.
 * - Sin cuenta: crea la cuenta (nombre y contraseña con la política de contraseñas) y acepta en la misma transacción.
 *   Riesgo residual aceptado: quien tenga el enlace puede crear esa cuenta; el correo queda SIN verificar hasta la
 *   Fase 12 (envío por correo).
 * - Un solo uso: la fila se bloquea (`FOR UPDATE`) y se marca aceptada en la misma transacción.
 * - Aceptar habilita una membresía (consumo facturable): la empresa debe admitir USERS_ADD en ese momento
 *   (matriz de estados o excepción vigente de YEBO).
 */
@Injectable()
export class InvitationAcceptanceService {
  constructor(
    private readonly db: IdentityPrismaService,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiterService,
    private readonly sessions: SessionService,
    private readonly tenants: TenantResolverService,
    private readonly clock: Clock,
  ) {}

  async preview(token: unknown, ip: string): Promise<HubInvitationPreview> {
    await this.limit(ip);
    const parsed = parseInvitationToken(token);
    if (!parsed) throw INVALID();
    const invitation = await this.find(parsed);
    const tenant = await this.tenants.byId(parsed.tenantId);
    if (!tenant) throw INVALID();
    return {
      tradeName: tenant.tradeName,
      email: invitation.email,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /** Acepta con la sesión del hub de este navegador. */
  async accept(identitySessionId: string | null, token: unknown, ip: string): Promise<HubInvitationAccepted> {
    await this.limit(ip);
    const parsed = parseInvitationToken(token);
    if (!parsed) throw INVALID();
    const identity = identitySessionId
      ? await this.sessions.findLiveIdentitySession(identitySessionId)
      : null;
    const user = identity
      ? await this.db.client.user.findUnique({
          where: { id: identity.userId },
          select: { id: true, email: true, status: true },
        })
      : null;
    if (!user || user.status !== 'ACTIVE') {
      throw new AppError('UNAUTHENTICATED', 'Inicia sesión para aceptar la invitación', 401);
    }
    return this.consume(parsed, { userId: user.id, email: user.email });
  }

  /** Crea la cuenta del correo invitado, acepta y abre la sesión del hub. */
  async register(input: {
    token: unknown;
    fullName: string;
    password: string;
    ip: string;
    userAgent?: string;
  }): Promise<HubInvitationAccepted & { identitySessionId: string; absoluteExpiresAt: Date }> {
    await this.limit(input.ip);
    const parsed = parseInvitationToken(input.token);
    if (!parsed) throw INVALID();
    const { email } = await this.find(parsed);
    const problem = passwordProblem(input.password, { email, fullName: input.fullName });
    if (problem) throw new AppError('VALIDATION_FAILED', problem, 400);
    if (await this.db.client.user.findUnique({ where: { email }, select: { id: true } })) {
      throw ACCOUNT_EXISTS();
    }
    const passwordHash = await this.hasher.hash(input.password);
    const accepted = await this.consume(parsed, {
      newUser: { email, fullName: input.fullName, passwordHash },
    });
    const session = await this.sessions.createIdentitySession({
      userId: accepted.userId,
      authMethods: ['pwd'],
      ip: input.ip,
      ...(input.userAgent !== undefined && { userAgent: input.userAgent }),
    });
    return {
      tradeName: accepted.tradeName,
      tenantHost: accepted.tenantHost,
      identitySessionId: session.id,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async consume(parsed: Parsed, who: Who): Promise<HubInvitationAccepted & { userId: string }> {
    const tenant = await this.tenants.byId(parsed.tenantId);
    if (!tenant) throw INVALID();
    const now = this.clock.now();
    try {
      return await this.db.client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${parsed.tenantId}, true)`;
        const [invitation] = await tx.$queryRaw<
          {
            id: string;
            email: string;
            role_ids: string[];
            expires_at: Date;
            accepted_at: Date | null;
            revoked_at: Date | null;
          }[]
        >`SELECT id, email::text AS email, role_ids, expires_at, accepted_at, revoked_at
            FROM membership_invitations WHERE token_hash = ${new Uint8Array(parsed.hash)} FOR UPDATE`;
        if (!invitation || !usable(invitation, now)) throw INVALID();
        if ('email' in who && who.email.toLowerCase() !== invitation.email) {
          throw new AppError(
            'FORBIDDEN',
            'Esta invitación es para otro correo. Inicia sesión con la cuenta invitada',
            403,
          );
        }

        // Habilitar una membresía es USERS_ADD: estado vigente (sin caché) o excepción vigente de YEBO.
        const phase = tenantPhase(tenant, now);
        const allowed =
          isOperationAllowed('USERS_ADD', phase) ||
          ((phase === 'SUSPENDED' || phase === 'EXPIRED') &&
            (
              await tx.$queryRaw<{ id: string }[]>`
                SELECT id FROM tenant_operation_overrides
                 WHERE category = 'USERS_ADD' AND ended_at IS NULL AND valid_from <= ${now} AND valid_to > ${now}
                 LIMIT 1`
            ).length > 0);
        if (!allowed) {
          throw new AppError('TENANT_RESTRICTED', 'La empresa no puede añadir personas en este momento', 403);
        }

        const userId =
          'userId' in who
            ? who.userId
            : (
                await tx.user.create({
                  data: {
                    email: who.newUser.email,
                    fullName: who.newUser.fullName,
                    passwordHash: who.newUser.passwordHash,
                    status: 'ACTIVE',
                  },
                  select: { id: true },
                })
              ).id;

        const roles = await tx.role.findMany({
          where: { id: { in: invitation.role_ids }, archivedAt: null },
          select: { id: true },
        });
        if (roles.length === 0) {
          throw new AppError('CONFLICT', 'Los roles de esta invitación ya no existen: pide una nueva', 409);
        }

        const existing = await tx.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId: parsed.tenantId, userId } },
          select: { id: true },
        });
        const membershipId = existing
          ? (
              await tx.tenantMembership.update({
                where: { id: existing.id },
                // Reactivar o sumar roles: la versión de permisos invalida los tokens con permisos antiguos.
                data: { status: 'ACTIVE', permissionsVersion: { increment: 1 } },
                select: { id: true },
              })
            ).id
          : (
              await tx.tenantMembership.create({
                data: { tenantId: parsed.tenantId, userId, status: 'ACTIVE' },
                select: { id: true },
              })
            ).id;
        await tx.membershipRole.createMany({
          data: roles.map((r) => ({ tenantId: parsed.tenantId, membershipId, roleId: r.id })),
          skipDuplicates: true,
        });
        await tx.membershipInvitation.updateMany({
          where: { id: invitation.id },
          data: { acceptedAt: now, acceptedMembershipId: membershipId },
        });
        return { userId, tradeName: tenant.tradeName, tenantHost: tenant.primaryHost };
      });
    } catch (error) {
      // Dos cuentas nuevas simultáneas con el mismo correo (dos invitaciones): solo una se crea.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw ACCOUNT_EXISTS();
      throw error;
    }
  }

  /** Lectura sin consumir (vista previa y política de contraseñas). */
  private async find(parsed: Parsed): Promise<{ email: string; expiresAt: Date }> {
    const invitation = await this.db.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${parsed.tenantId}, true)`;
      return tx.membershipInvitation.findUnique({
        where: { tokenHash: new Uint8Array(parsed.hash) },
        select: { email: true, expiresAt: true, acceptedAt: true, revokedAt: true },
      });
    });
    if (
      !invitation ||
      !usable(
        {
          expires_at: invitation.expiresAt,
          accepted_at: invitation.acceptedAt,
          revoked_at: invitation.revokedAt,
        },
        this.clock.now(),
      )
    ) {
      throw INVALID();
    }
    return { email: invitation.email, expiresAt: invitation.expiresAt };
  }

  private async limit(ip: string): Promise<void> {
    const r = await this.limiter.hit(
      `invite:ip:${ip}`,
      INVITATION_LIMITS.perIp,
      INVITATION_LIMITS.windowSeconds,
    );
    if (!r.allowed) throw TOO_MANY();
  }
}

const ACCOUNT_EXISTS = (): AppError =>
  new AppError(
    'CONFLICT',
    'Ya existe una cuenta con este correo: inicia sesión para aceptar la invitación',
    409,
  );

function usable(
  i: { expires_at: Date; accepted_at: Date | null; revoked_at: Date | null },
  now: Date,
): boolean {
  return !i.accepted_at && !i.revoked_at && i.expires_at.getTime() > now.getTime();
}
