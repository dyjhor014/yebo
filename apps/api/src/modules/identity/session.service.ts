import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import type { SessionRevokeReason } from '../../generated/prisma/enums';
import { normalizeHost } from '../tenancy/host';
import { AccessTokenService } from './access-token.service';
import { Clock } from './clock';
import { IdentityPrismaService } from './identity-prisma.service';
import { decryptSuccessor, encryptSuccessor } from './successor-crypto';

/** Tokens emitidos al abrir o renovar una sesión de empresa. El refresh token solo existe en claro aquí. */
export interface IssuedTokens {
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface IdentitySessionInput {
  userId: string;
  authMethods: readonly string[];
  ip?: string;
  userAgent?: string;
}

/** Resultado de verificar una sesión de empresa en un request (identity-and-sessions §7, paso 3). */
export type SessionCheck =
  | { active: false }
  | { active: true; userId: string; tenantId: string; membershipId: string; permissionsVersion: number };

/** 256 bits en base64url, sin relleno. */
const REFRESH_TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const UUID = z.uuid();

const INVALID_SESSION = (): AppError => new AppError('UNAUTHENTICATED', 'Sesión no válida', 401);

interface SubjectState {
  userId: string;
  tenantId: string;
  membershipId: string;
  permissionsVersion: number;
}

interface LockedToken {
  id: string;
  parent_id: string | null;
  rotated_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
  successor_ciphertext: Uint8Array | null;
}

interface SessionRow {
  user_id: string;
  tenant_id: string;
  membership_id: string;
  host: string;
  revoked_at: Date | null;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  identity_revoked_at: Date | null;
  membership_status: string;
  permissions_version: number;
  user_status: string;
}

type RefreshOutcome =
  | { kind: 'issued'; tokens: IssuedTokens }
  | { kind: 'reuse'; sessionId: string; userId: string; tenantId: string }
  | { kind: 'in-progress' };

export type IdentityTx = Parameters<Parameters<IdentityPrismaService['client']['$transaction']>[0]>[0];

/**
 * Sesiones de identidad y de empresa, refresh tokens y revocación (ADR-009; identity-and-sessions §6–8).
 *
 * - Fuente de verdad: PostgreSQL, con el rol dedicado `yebo_identity`. **Cada verificación consulta PostgreSQL**
 *   (no hay caché positiva): una sesión revocada se rechaza en toda verificación que empiece después del COMMIT
 *   de la revocación. Redis no interviene en identidad.
 * - El tenant de las operaciones de empresa sale del contexto del request (host resuelto y validado por el
 *   backend, ADR-004), nunca de un parámetro del llamador.
 * - Orden de bloqueo (ADR-026): sesión de identidad → sesiones de empresa (por id) → refresh tokens.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly graceMs: number;

  constructor(
    private readonly db: IdentityPrismaService,
    private readonly tokens: AccessTokenService,
    private readonly clock: Clock,
    private readonly cls: ClsService<RequestContextStore>,
    @Inject(ENV) env: Env,
  ) {
    this.idleMs = env.AUTH_SESSION_IDLE_MINUTES * 60_000;
    this.absoluteMs = env.AUTH_SESSION_ABSOLUTE_DAYS * 86_400_000;
    this.graceMs = env.AUTH_REFRESH_GRACE_SECONDS * 1000;
  }

  /** Sesión de identidad del hub, tras autenticar las credenciales (el login HTTP llega en la etapa 3.2b). */
  async createIdentitySession(input: IdentitySessionInput): Promise<{ id: string; absoluteExpiresAt: Date }> {
    const now = this.clock.now();
    const user = await this.db.client.user.findUnique({
      where: { id: input.userId },
      select: { status: true },
    });
    if (user?.status !== 'ACTIVE') throw INVALID_SESSION();
    const absoluteExpiresAt = new Date(now.getTime() + this.absoluteMs);
    return this.db.client.identitySession.create({
      data: {
        userId: input.userId,
        authMethods: [...input.authMethods],
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
        lastSeenAt: now,
        idleExpiresAt: minDate(new Date(now.getTime() + this.idleMs), absoluteExpiresAt),
        absoluteExpiresAt,
      },
      select: { id: true, absoluteExpiresAt: true },
    });
  }

  /**
   * Abre una sesión de empresa hija de una sesión de identidad (al canjear el código de autorización, 3.2b).
   * El tenant se DERIVA del host (dominio VERIFIED); si el request ya tiene un tenant en su contexto, deben
   * coincidir. Exige sesión de identidad vigente, usuario ACTIVE y membresía ACTIVE. El estado del tenant
   * no bloquea la sesión (identity-and-sessions §8; ADR-023).
   */
  async openTenantSession(input: { identitySessionId: string; host: string }): Promise<IssuedTokens> {
    const now = this.clock.now();
    const result = await this.db.client.$transaction((tx) => this.openWithinTransaction(tx, input, now));
    if (!result) throw INVALID_SESSION();
    return result;
  }

  /**
   * Igual que `openTenantSession`, dentro de una transacción ya abierta (uso interno del módulo identity:
   * el canje del código de autorización consume el código y abre la sesión de forma atómica).
   * Devuelve `null` si no se cumple alguna condición; quien llama decide si confirma la transacción.
   */
  async openWithinTransaction(
    tx: IdentityTx,
    input: { identitySessionId: string; host: string },
    now: Date,
  ): Promise<IssuedTokens | null> {
    const host = normalizeHost(input.host);
    if (!host || !UUID.safeParse(input.identitySessionId).success) return null;
    const contextTenant = this.contextTenantId();
    {
      // FOR SHARE: una revocación concurrente de la sesión de identidad espera a este COMMIT (y entonces revoca
      // también esta hija), o este paso espera a la revocación y la ve. Nunca queda una hija viva de un padre revocado.
      const [identity] = await tx.$queryRaw<
        { user_id: string; revoked_at: Date | null; idle_expires_at: Date; absolute_expires_at: Date }[]
      >`SELECT user_id, revoked_at, idle_expires_at, absolute_expires_at
          FROM identity_sessions WHERE id = ${input.identitySessionId}::uuid FOR SHARE`;
      if (
        !identity ||
        !isLive(identity.revoked_at, identity.idle_expires_at, identity.absolute_expires_at, now)
      ) {
        return null;
      }
      const domain = await tx.tenantDomain.findUnique({
        where: { host },
        select: { tenantId: true, verificationStatus: true },
      });
      if (!domain || domain.verificationStatus !== 'VERIFIED') return null;
      if (contextTenant && contextTenant !== domain.tenantId) return null;
      const tenantId = domain.tenantId;

      const user = await tx.user.findUnique({ where: { id: identity.user_id }, select: { status: true } });
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId: identity.user_id } },
        select: { id: true, status: true, permissionsVersion: true },
      });
      if (user?.status !== 'ACTIVE' || membership?.status !== 'ACTIVE') return null;

      const absoluteExpiresAt = minDate(
        new Date(now.getTime() + this.absoluteMs),
        identity.absolute_expires_at,
      );
      const validUntil = minDate(new Date(now.getTime() + this.idleMs), absoluteExpiresAt);
      const session = await tx.tenantSession.create({
        data: {
          identitySessionId: input.identitySessionId,
          userId: identity.user_id,
          tenantId,
          membershipId: membership.id,
          host,
          lastSeenAt: now,
          idleExpiresAt: validUntil,
          absoluteExpiresAt,
        },
        select: { id: true },
      });
      const refreshToken = newRefreshToken();
      await tx.refreshToken.create({
        data: { tenantSessionId: session.id, tokenHash: sha256(refreshToken), expiresAt: validUntil },
      });
      const subject: SubjectState = {
        userId: identity.user_id,
        tenantId,
        membershipId: membership.id,
        permissionsVersion: membership.permissionsVersion,
      };
      return this.issue(session.id, subject, refreshToken, validUntil);
    }
  }

  /** Sesión de identidad vigente (hub): no revocada ni expirada, con usuario ACTIVE. `null` en otro caso. */
  async findLiveIdentitySession(identitySessionId: string): Promise<{ userId: string } | null> {
    if (!UUID.safeParse(identitySessionId).success) return null;
    const now = this.clock.now();
    const session = await this.db.client.identitySession.findUnique({
      where: { id: identitySessionId },
      select: {
        userId: true,
        revokedAt: true,
        idleExpiresAt: true,
        absoluteExpiresAt: true,
        user: { select: { status: true } },
      },
    });
    if (!session || session.user.status !== 'ACTIVE') return null;
    return isLive(session.revokedAt, session.idleExpiresAt, session.absoluteExpiresAt, now)
      ? { userId: session.userId }
      : null;
  }

  /**
   * Rota el refresh token (identity-and-sessions §6):
   * - primer uso → sucesor nuevo; el anterior queda `rotated_at` y guarda el sucesor CIFRADO con una clave
   *   derivada de sí mismo (nunca en claro: ni en PostgreSQL, ni en Redis, ni en logs);
   * - de nuevo dentro de la ventana de gracia → se descifra y se devuelve el MISMO sucesor;
   * - de nuevo fuera de la ventana → reutilización: se revoca la sesión de empresa completa (la familia).
   */
  async refresh(rawToken: string, rawHost: string): Promise<IssuedTokens> {
    const host = normalizeHost(rawHost);
    if (!host || !REFRESH_TOKEN_FORMAT.test(rawToken)) throw INVALID_SESSION();
    const now = this.clock.now();
    const contextTenant = this.contextTenantId();

    const outcome = await this.db.client.$transaction(async (tx): Promise<RefreshOutcome | null> => {
      const found = await tx.refreshToken.findUnique({
        where: { tokenHash: sha256(rawToken) },
        select: { id: true, tenantSessionId: true },
      });
      if (!found) return null;
      const sessionId = found.tenantSessionId;

      // Mismo orden que la revocación (sesión → token): sin interbloqueos y sin carreras con ella.
      await lockSessions(tx, [sessionId]);
      const [token] = await tx.$queryRaw<LockedToken[]>`
        SELECT id, parent_id, rotated_at, expires_at, revoked_at, successor_ciphertext
          FROM refresh_tokens WHERE id = ${found.id}::uuid FOR UPDATE`;
      const session = await readSession(tx, sessionId);
      if (!token || !session) return null;

      // Un token presentado en otro dominio no se acepta (las cookies están ligadas al host).
      if (session.host !== host || !sessionIsActive(session, now)) return null;
      if (contextTenant && contextTenant !== session.tenant_id) return null;
      if (token.revoked_at || token.expires_at.getTime() <= now.getTime()) return null;
      const subject = toSubject(session);

      if (token.rotated_at === null) {
        const validUntil = minDate(new Date(now.getTime() + this.idleMs), session.absolute_expires_at);
        const successor = newRefreshToken();
        await tx.refreshToken.create({
          data: {
            tenantSessionId: sessionId,
            parentId: token.id,
            tokenHash: sha256(successor),
            expiresAt: validUntil,
          },
        });
        await tx.refreshToken.update({
          where: { id: token.id },
          data: {
            rotatedAt: now,
            successorCiphertext: new Uint8Array(
              encryptSuccessor(rawToken, successor, { parentId: token.id, sessionId }),
            ),
          },
        });
        // El cifrado del abuelo ya no sirve fuera de su ventana de gracia: se elimina.
        if (token.parent_id) {
          await tx.refreshToken.updateMany({
            where: { id: token.parent_id, rotatedAt: { lte: new Date(now.getTime() - this.graceMs) } },
            data: { successorCiphertext: null },
          });
        }
        await tx.tenantSession.update({
          where: { id: sessionId },
          data: { lastSeenAt: now, idleExpiresAt: validUntil },
        });
        return { kind: 'issued', tokens: this.issue(sessionId, subject, successor, validUntil) };
      }

      if (now.getTime() - token.rotated_at.getTime() <= this.graceMs) {
        if (!token.successor_ciphertext) return { kind: 'in-progress' };
        const successor = decryptSuccessor(rawToken, token.successor_ciphertext, {
          parentId: token.id,
          sessionId,
        });
        if (!successor) return null;
        const successorRow = await tx.refreshToken.findFirst({
          where: { tenantSessionId: sessionId, parentId: token.id, tokenHash: sha256(successor) },
          select: { expiresAt: true, revokedAt: true },
        });
        if (!successorRow || successorRow.revokedAt) return null;
        return { kind: 'issued', tokens: this.issue(sessionId, subject, successor, successorRow.expiresAt) };
      }

      await revokeSessionsInTx(tx, [sessionId], 'REFRESH_REUSE', now);
      return { kind: 'reuse', sessionId, userId: session.user_id, tenantId: session.tenant_id };
    });

    if (!outcome) throw INVALID_SESSION();
    switch (outcome.kind) {
      case 'issued':
        return outcome.tokens;
      case 'in-progress':
        throw new AppError('CONFLICT', 'La sesión se está renovando; reintenta', 409);
      case 'reuse':
        // Evento de seguridad (posible robo). Nunca se registra ningún token. audit_logs llega con su módulo.
        this.logger.warn(
          {
            event: 'auth.refresh_token_reuse',
            sessionId: outcome.sessionId,
            userId: outcome.userId,
            tenantId: outcome.tenantId,
          },
          'Reutilización de refresh token: se revoca la sesión de empresa',
        );
        throw INVALID_SESSION();
    }
  }

  /**
   * Verificación por request (identity-and-sessions §7, paso 3). **Siempre en PostgreSQL**, en una sola
   * sentencia: sesión de empresa y de identidad no revocadas ni expiradas, membresía y usuario ACTIVE, y
   * `permissions_version` vigente. Si el request tiene tenant en su contexto, la sesión debe ser de ese tenant.
   */
  async checkSession(sessionId: string): Promise<SessionCheck> {
    if (!UUID.safeParse(sessionId).success) return { active: false };
    const now = this.clock.now();
    const session = await readSession(this.db.client, sessionId);
    if (!session || !sessionIsActive(session, now)) return { active: false };
    const contextTenant = this.contextTenantId();
    if (contextTenant && contextTenant !== session.tenant_id) return { active: false };
    return { active: true, ...toSubject(session) };
  }

  // ---------------------------------------------------------------------------------------------
  // Revocación (identity-and-sessions §8). Surte efecto en toda verificación que empiece tras el COMMIT.
  // ---------------------------------------------------------------------------------------------

  /** Una sesión de empresa del tenant del contexto. Devuelve `false` si no existe en ese tenant. */
  async revokeTenantSession(sessionId: string, reason: SessionRevokeReason): Promise<boolean> {
    const tenantId = this.requireContextTenantId();
    if (!UUID.safeParse(sessionId).success) return false;
    const now = this.clock.now();
    return this.db.client.$transaction(async (tx) => {
      const session = await tx.tenantSession.findFirst({
        where: { id: sessionId, tenantId },
        select: { id: true },
      });
      if (!session) return false;
      await revokeSessionsInTx(tx, [session.id], reason, now);
      return true;
    });
  }

  /**
   * Las sesiones de UNA membresía del tenant del contexto: la empresa suspende o revoca el acceso, o su
   * administrador cierra las sesiones del usuario. Nunca afecta a otras empresas.
   */
  async revokeMembershipSessions(membershipId: string, reason: SessionRevokeReason): Promise<number> {
    const tenantId = this.requireContextTenantId();
    if (!UUID.safeParse(membershipId).success) return 0;
    const now = this.clock.now();
    return this.db.client.$transaction(async (tx) => {
      const sessions = await tx.tenantSession.findMany({
        where: { tenantId, membershipId, revokedAt: null },
        select: { id: true },
      });
      return (
        await revokeSessionsInTx(
          tx,
          sessions.map((s) => s.id),
          reason,
          now,
        )
      ).length;
    });
  }

  /**
   * "Cerrar sesión" en el hub: la sesión de identidad del navegador y todas sus sesiones de empresa hijas.
   * Ámbito de identidad (no de empresa): en la 3.2b el id sale de la cookie del hub, nunca del cliente.
   */
  async revokeIdentitySession(identitySessionId: string, reason: SessionRevokeReason): Promise<void> {
    if (!UUID.safeParse(identitySessionId).success) return;
    const now = this.clock.now();
    await this.db.client.$transaction(async (tx) => {
      await tx.identitySession.updateMany({
        where: { id: identitySessionId, revokedAt: null },
        data: { revokedAt: now, revokeReason: reason },
      });
      const children = await tx.tenantSession.findMany({
        where: { identitySessionId, revokedAt: null },
        select: { id: true },
      });
      await revokeSessionsInTx(
        tx,
        children.map((c) => c.id),
        reason,
        now,
      );
    });
  }

  /**
   * Todas las sesiones del usuario: "cerrar en todos los dispositivos", cambio de contraseña, usuario
   * deshabilitado. Ámbito de usuario: en la 3.2b el userId sale de la sesión de identidad autenticada.
   */
  async revokeAllForUser(
    userId: string,
    reason: SessionRevokeReason,
    options: { exceptIdentitySessionId?: string } = {},
  ): Promise<void> {
    if (!UUID.safeParse(userId).success) return;
    const now = this.clock.now();
    const keep = options.exceptIdentitySessionId;
    await this.db.client.$transaction(async (tx) => {
      await tx.identitySession.updateMany({
        where: { userId, revokedAt: null, ...(keep && { id: { not: keep } }) },
        data: { revokedAt: now, revokeReason: reason },
      });
      const sessions = await tx.tenantSession.findMany({
        where: { userId, revokedAt: null, ...(keep && { identitySessionId: { not: keep } }) },
        select: { id: true },
      });
      await revokeSessionsInTx(
        tx,
        sessions.map((s) => s.id),
        reason,
        now,
      );
    });
  }

  private contextTenantId(): string | undefined {
    return this.cls.isActive() ? this.cls.get('tenantId') : undefined;
  }

  private requireContextTenantId(): string {
    const tenantId = this.contextTenantId();
    if (!tenantId) throw new AppError('FORBIDDEN', 'Operación de empresa sin contexto de tenant', 403);
    return tenantId;
  }

  private issue(
    sessionId: string,
    subject: SubjectState,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): IssuedTokens {
    const access = this.tokens.sign({
      sub: subject.userId,
      sid: sessionId,
      tid: subject.tenantId,
      mid: subject.membershipId,
      ver: subject.permissionsVersion,
    });
    return {
      sessionId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt,
    };
  }
}

/** Una sola sentencia (una sola instantánea): sesión, sesión de identidad, membresía y usuario. */
async function readSession(
  db: Pick<IdentityTx, '$queryRaw'>,
  sessionId: string,
): Promise<SessionRow | undefined> {
  const [row] = await db.$queryRaw<SessionRow[]>`
    SELECT ts.user_id, ts.tenant_id, ts.membership_id, ts.host::text AS host,
           ts.revoked_at, ts.idle_expires_at, ts.absolute_expires_at,
           ids.revoked_at AS identity_revoked_at,
           m.status::text AS membership_status, m.permissions_version,
           u.status::text AS user_status
      FROM tenant_sessions ts
      JOIN identity_sessions ids ON ids.id = ts.identity_session_id
      JOIN tenant_memberships m ON m.tenant_id = ts.tenant_id AND m.id = ts.membership_id
      JOIN users u ON u.id = ts.user_id
     WHERE ts.id = ${sessionId}::uuid`;
  return row;
}

function sessionIsActive(session: SessionRow, now: Date): boolean {
  return (
    isLive(session.revoked_at, session.idle_expires_at, session.absolute_expires_at, now) &&
    session.identity_revoked_at === null &&
    session.membership_status === 'ACTIVE' &&
    session.user_status === 'ACTIVE'
  );
}

function toSubject(session: SessionRow): SubjectState {
  return {
    userId: session.user_id,
    tenantId: session.tenant_id,
    membershipId: session.membership_id,
    permissionsVersion: session.permissions_version,
  };
}

/** Bloquea sesiones de empresa en orden de id (ADR-026): dos revocaciones solapadas nunca se interbloquean. */
async function lockSessions(tx: IdentityTx, sessionIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(sessionIds)].sort();
  if (ids.length === 0) return [];
  await tx.$queryRaw`SELECT id FROM tenant_sessions WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  return ids;
}

/** Revoca sesiones de empresa y sus refresh tokens, y elimina los sucesores cifrados que quedaran. */
export async function revokeSessionsInTx(
  tx: IdentityTx,
  sessionIds: readonly string[],
  reason: SessionRevokeReason,
  now: Date,
): Promise<string[]> {
  const ids = await lockSessions(tx, sessionIds);
  if (ids.length === 0) return [];
  await tx.tenantSession.updateMany({
    where: { id: { in: ids }, revokedAt: null },
    data: { revokedAt: now, revokeReason: reason },
  });
  await tx.refreshToken.updateMany({
    where: { tenantSessionId: { in: ids }, revokedAt: null },
    data: { revokedAt: now },
  });
  await tx.refreshToken.updateMany({
    where: { tenantSessionId: { in: ids }, successorCiphertext: { not: null } },
    data: { successorCiphertext: null },
  });
  return ids;
}

function isLive(revokedAt: Date | null, idleExpiresAt: Date, absoluteExpiresAt: Date, now: Date): boolean {
  const t = now.getTime();
  return !revokedAt && t < idleExpiresAt.getTime() && t < absoluteExpiresAt.getTime();
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

function sha256(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(value).digest());
}
