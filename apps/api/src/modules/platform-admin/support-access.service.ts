import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CreateSupportGrantRequest, SupportGrant, SupportHandoffResponse } from '@yebo/contracts';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import type { SupportPrincipal } from '../../infrastructure/context/request-context';
import { Clock } from '../identity/clock';
import { readSupportGrants } from '../support/grant-view';
import { BackofficePrismaService } from './backoffice-prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import { ipOf, type PlatformPrincipal, type RequestMeta } from './platform-auth.service';
import { PLATFORM_ROLE_PERMISSIONS } from './platform-permissions';

const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
export const SUPPORT_HANDOFF_TTL_MS = 60_000;
export const SUPPORT_IDLE_MS = 30 * 60_000;
/** La inactividad se renueva como mucho una vez por minuto (como la sesión del panel). */
const RENEW_EVERY_MS = 60_000;

const sha256 = (v: string) => new Uint8Array(createHash('sha256').update(v).digest());

/** Roles de plataforma que pueden usar un acceso de soporte (permiso `platform.support.access`). */
const SUPPORT_ROLES = Object.entries(PLATFORM_ROLE_PERMISSIONS)
  .filter(([, perms]) => perms.includes('platform.support.access'))
  .map(([role]) => role);

/**
 * Acceso de soporte del staff a una empresa (Fase 4.6). Rol `yebo_backoffice`, siempre con el contexto de la empresa.
 * Un acceso es USABLE si no está revocado, ya empezó, no ha vencido y, si la empresa exige aprobación, está aprobado.
 * - El staff lo crea (motivo, alcance y hasta 8 h) y es PERSONAL: solo quien lo creó abre sesiones con él.
 * - Abrir sesión: el panel emite un código de un solo uso (60 s) para el host de la empresa; el navegador lo canjea
 *   allí y recibe una cookie opaca de sesión de soporte (30 min de inactividad, nunca más allá del acceso).
 * - Cada petición se verifica en PostgreSQL (sesión, acceso y miembro del staff ACTIVE con permiso de soporte) y se
 *   registra; la empresa lo ve todo.
 */
@Injectable()
export class SupportAccessService {
  constructor(
    private readonly db: BackofficePrismaService,
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
  ) {}

  async create(
    actor: PlatformPrincipal,
    tenantId: string,
    input: CreateSupportGrantRequest,
    meta: RequestMeta,
  ): Promise<SupportGrant> {
    await this.requireTenant(tenantId);
    const now = this.clock.now();
    return this.db.withTenant(tenantId, async (tx) => {
      const settings = await tx.tenantSetting.findUnique({
        where: { tenantId },
        select: { supportRequiresApproval: true },
      });
      const grant = await tx.supportAccessGrant.create({
        data: {
          tenantId,
          platformUserId: actor.platformUserId,
          staffName: actor.fullName,
          staffEmail: actor.email,
          reason: input.reason,
          scope: input.scope,
          startsAt: now,
          expiresAt: new Date(now.getTime() + input.durationMinutes * 60_000),
          requiresApproval: settings?.supportRequiresApproval ?? false,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'support.grant_created',
          targetType: 'support_access_grant',
          targetId: grant.id,
          tenantId,
          detail: { scope: input.scope, durationMinutes: input.durationMinutes, reason: input.reason },
          ...ipOf(meta),
        },
        tx,
      );
      const all = await readSupportGrants(tx, now);
      return all.find((g) => g.id === grant.id) as SupportGrant;
    });
  }

  async list(tenantId: string): Promise<SupportGrant[]> {
    await this.requireTenant(tenantId);
    return this.db.withTenant(tenantId, (tx) => readSupportGrants(tx, this.clock.now()));
  }

  async revoke(
    actor: PlatformPrincipal,
    tenantId: string,
    grantId: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (!UUID.safeParse(grantId).success) throw NOT_FOUND();
    await this.requireTenant(tenantId);
    const now = this.clock.now();
    await this.db.withTenant(tenantId, async (tx) => {
      const done = await tx.supportAccessGrant.updateMany({
        where: { id: grantId, revokedAt: null },
        data: { revokedAt: now, revokedByKind: 'PLATFORM_USER', revokedById: actor.platformUserId },
      });
      if (done.count !== 1) throw NOT_FOUND();
      await tx.supportSession.updateMany({ where: { grantId, revokedAt: null }, data: { revokedAt: now } });
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'support.grant_revoked',
          targetType: 'support_access_grant',
          targetId: grantId,
          tenantId,
          ...ipOf(meta),
        },
        tx,
      );
    });
  }

  /** Enlace de un solo uso para abrir la sesión de soporte en el host de la empresa (solo quien creó el acceso). */
  async handoff(
    actor: PlatformPrincipal,
    tenantId: string,
    grantId: string,
    meta: RequestMeta,
  ): Promise<SupportHandoffResponse> {
    if (!UUID.safeParse(grantId).success) throw NOT_FOUND();
    await this.requireTenant(tenantId);
    const now = this.clock.now();
    const host = await this.db.client.tenantDomain.findFirst({
      where: { tenantId, isPrimary: true, verificationStatus: 'VERIFIED' },
      select: { host: true },
    });
    if (!host) throw new AppError('CONFLICT', 'La empresa no tiene un dominio verificado', 409);
    return this.db.withTenant(tenantId, async (tx) => {
      const grant = await tx.supportAccessGrant.findFirst({
        where: { id: grantId, platformUserId: actor.platformUserId },
        select: {
          revokedAt: true,
          startsAt: true,
          expiresAt: true,
          requiresApproval: true,
          approvedAt: true,
        },
      });
      if (!grant) throw NOT_FOUND();
      if (!usable(grant, now)) {
        throw new AppError(
          'CONFLICT',
          grant.requiresApproval && !grant.approvedAt && !grant.revokedAt && grant.expiresAt > now
            ? 'La empresa aún no ha aprobado este acceso'
            : 'El acceso no está vigente',
          409,
        );
      }
      const code = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + SUPPORT_HANDOFF_TTL_MS);
      await tx.supportHandoff.create({
        data: { tenantId, grantId, codeHash: sha256(code), expiresAt, createdAt: now },
        select: { id: true },
      });
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'support.handoff_issued',
          targetType: 'support_access_grant',
          targetId: grantId,
          tenantId,
          ...ipOf(meta),
        },
        tx,
      );
      return {
        url: `https://${host.host}/api/v1/support/session?code=${encodeURIComponent(code)}`,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  /** Canje del código en el host de la empresa: consume el código (una vez) y abre la sesión de soporte. */
  async redeem(tenantId: string, code: string): Promise<{ token: string; maxAgeSeconds: number } | null> {
    if (code.length < 20 || code.length > 100) return null;
    const now = this.clock.now();
    return this.db.withTenant(tenantId, async (tx) => {
      const [handoff] = await tx.$queryRaw<{ id: string; grant_id: string }[]>`
        SELECT id, grant_id FROM support_handoffs
         WHERE code_hash = ${sha256(code)} AND consumed_at IS NULL AND expires_at > ${now}
         FOR UPDATE`;
      if (!handoff) return null;
      await tx.supportHandoff.updateMany({ where: { id: handoff.id }, data: { consumedAt: now } });
      const grant = await tx.supportAccessGrant.findUnique({
        where: { id: handoff.grant_id },
        select: {
          platformUserId: true,
          revokedAt: true,
          startsAt: true,
          expiresAt: true,
          requiresApproval: true,
          approvedAt: true,
        },
      });
      if (!grant || !usable(grant, now)) return null;
      const token = randomBytes(32).toString('base64url');
      const session = await tx.supportSession.create({
        data: {
          tenantId,
          grantId: handoff.grant_id,
          tokenHash: sha256(token),
          lastSeenAt: now,
          idleExpiresAt: new Date(Math.min(now.getTime() + SUPPORT_IDLE_MS, grant.expiresAt.getTime())),
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          platformUserId: grant.platformUserId,
          action: 'support.session_started',
          targetType: 'support_session',
          targetId: session.id,
          tenantId,
        },
        tx,
      );
      return {
        token,
        maxAgeSeconds: Math.max(1, Math.floor((grant.expiresAt.getTime() - now.getTime()) / 1000)),
      };
    });
  }

  /**
   * Verificación en cada petición (AuthenticationGuard): sesión viva, acceso usable y miembro del staff ACTIVE con
   * permiso de soporte. `null` = no autenticado.
   */
  async verify(tenantId: string, token: string): Promise<SupportPrincipal | null> {
    if (token.length < 20 || token.length > 100) return null;
    const now = this.clock.now();
    return this.db.withTenant(tenantId, async (tx) => {
      const session = await tx.supportSession.findUnique({
        where: { tokenHash: sha256(token) },
        select: {
          id: true,
          revokedAt: true,
          lastSeenAt: true,
          idleExpiresAt: true,
          grant: {
            select: {
              id: true,
              platformUserId: true,
              scope: true,
              revokedAt: true,
              startsAt: true,
              expiresAt: true,
              requiresApproval: true,
              approvedAt: true,
            },
          },
        },
      });
      if (!session || session.revokedAt || session.idleExpiresAt <= now || !usable(session.grant, now)) {
        return null;
      }
      const staff = await tx.platformUser.findUnique({
        where: { id: session.grant.platformUserId },
        select: { status: true, role: true },
      });
      if (!staff || staff.status !== 'ACTIVE' || !SUPPORT_ROLES.includes(staff.role)) return null;
      if (now.getTime() - session.lastSeenAt.getTime() >= RENEW_EVERY_MS) {
        await tx.supportSession.updateMany({
          where: { id: session.id },
          data: {
            lastSeenAt: now,
            idleExpiresAt: new Date(
              Math.min(now.getTime() + SUPPORT_IDLE_MS, session.grant.expiresAt.getTime()),
            ),
          },
        });
      }
      return {
        sessionId: session.id,
        grantId: session.grant.id,
        platformUserId: session.grant.platformUserId,
        scope: session.grant.scope,
      };
    });
  }

  /** Registro de una petición del staff en la empresa (la empresa lo ve). */
  async log(tenantId: string, principal: SupportPrincipal, method: string, route: string): Promise<void> {
    await this.db.withTenant(tenantId, (tx) =>
      tx.supportAccessLog.create({
        data: {
          tenantId,
          grantId: principal.grantId,
          platformUserId: principal.platformUserId,
          method,
          route: route.slice(0, 300),
          occurredAt: this.clock.now(),
        },
        select: { id: true },
      }),
    );
  }

  private async requireTenant(tenantId: string): Promise<void> {
    if (!UUID.safeParse(tenantId).success) throw NOT_FOUND();
    if (!(await this.db.client.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })))
      throw NOT_FOUND();
  }
}

function usable(
  g: {
    revokedAt: Date | null;
    startsAt: Date;
    expiresAt: Date;
    requiresApproval: boolean;
    approvedAt: Date | null;
  },
  now: Date,
): boolean {
  return (
    !g.revokedAt && g.startsAt <= now && g.expiresAt > now && (!g.requiresApproval || g.approvedAt !== null)
  );
}
