import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { normalizeHost } from '../tenancy/host';
import { Clock } from './clock';
import { IdentityPrismaService } from './identity-prisma.service';
import {
  CODE_CHALLENGE_FORMAT,
  CODE_VERIFIER_FORMAT,
  OPAQUE_TOKEN_FORMAT,
  newOpaqueToken,
  verifyCodeChallenge,
} from './pkce';
import { SessionService, revokeSessionsInTx, type IssuedTokens } from './session.service';

/** Vida del código (identity-and-sessions §3): 60 s. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;

export type IssueResult =
  | { kind: 'issued'; code: string; redirectUri: string }
  /** No hay sesión de identidad vigente: el hub debe pedir credenciales. */
  | { kind: 'login-required' }
  /** El usuario no tiene membresía ACTIVE en esa empresa. */
  | { kind: 'no-access' };

interface LockedCode {
  id: string;
  identity_session_id: string;
  tenant_id: string;
  redirect_uri: string;
  redemption_host: string;
  code_challenge: string;
  expires_at: Date;
  consumed_at: Date | null;
  tenant_session_id: string | null;
}

type RedeemOutcome =
  | { kind: 'issued'; tokens: IssuedTokens }
  | { kind: 'invalid' }
  | { kind: 'reuse'; codeId: string; revokedSessionId: string | null };

const UUID = z.uuid();
const INVALID_GRANT = (): AppError =>
  new AppError('UNAUTHENTICATED', 'Código de autorización no válido', 401);

/** El redirect_uri nunca lo elige el cliente: se deriva del host verificado (identity-and-sessions §5). */
export function redirectUriFor(host: string): string {
  return `https://${host}/auth/callback`;
}

/**
 * OAuth 2.0 Authorization Code + PKCE S256 entre el hub de cuentas y los dominios de las empresas
 * (ADR-022; flujo propio decidido el 2026-11-09). Solo se guarda el SHA-256 del código.
 */
@Injectable()
export class AuthorizationCodeService {
  private readonly logger = new Logger(AuthorizationCodeService.name);
  private readonly idleMs: number;

  constructor(
    private readonly db: IdentityPrismaService,
    private readonly sessions: SessionService,
    private readonly clock: Clock,
    private readonly cls: ClsService<RequestContextStore>,
    @Inject(ENV) env: Env,
  ) {
    this.idleMs = env.AUTH_SESSION_IDLE_MINUTES * 60_000;
  }

  /**
   * Emite un código para `tenantHost` (ya validado como dominio VERIFIED por quien llama). Liga el código a la
   * sesión de identidad, al tenant del dominio, al host que lo canjeará, a su redirect_uri y al reto PKCE.
   * Renueva la inactividad de la sesión de identidad (el hub se está usando).
   */
  async issue(input: {
    identitySessionId: string;
    tenantHost: string;
    codeChallenge: string;
  }): Promise<IssueResult> {
    const host = normalizeHost(input.tenantHost);
    if (!host || !CODE_CHALLENGE_FORMAT.test(input.codeChallenge)) {
      throw new AppError('BAD_REQUEST', 'Solicitud de autorización no válida', 400);
    }
    if (!UUID.safeParse(input.identitySessionId).success) return { kind: 'login-required' };
    const now = this.clock.now();

    return this.db.client.$transaction(async (tx): Promise<IssueResult> => {
      // Mismo orden de bloqueo que la apertura de sesión: la sesión de identidad primero (ADR-026).
      const [identity] = await tx.$queryRaw<
        { user_id: string; revoked_at: Date | null; idle_expires_at: Date; absolute_expires_at: Date }[]
      >`SELECT user_id, revoked_at, idle_expires_at, absolute_expires_at
          FROM identity_sessions WHERE id = ${input.identitySessionId}::uuid FOR UPDATE`;
      const t = now.getTime();
      if (
        !identity ||
        identity.revoked_at ||
        t >= identity.idle_expires_at.getTime() ||
        t >= identity.absolute_expires_at.getTime()
      ) {
        return { kind: 'login-required' };
      }
      const user = await tx.user.findUnique({ where: { id: identity.user_id }, select: { status: true } });
      if (user?.status !== 'ACTIVE') return { kind: 'login-required' };

      const domain = await tx.tenantDomain.findUnique({
        where: { host },
        select: { tenantId: true, verificationStatus: true },
      });
      if (!domain || domain.verificationStatus !== 'VERIFIED') {
        throw new AppError('BAD_REQUEST', 'Solicitud de autorización no válida', 400);
      }
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: domain.tenantId, userId: identity.user_id } },
        select: { status: true },
      });
      if (membership?.status !== 'ACTIVE') return { kind: 'no-access' };

      const code = newOpaqueToken();
      const redirectUri = redirectUriFor(host);
      await tx.authorizationCode.create({
        data: {
          codeHash: sha256(code),
          userId: identity.user_id,
          tenantId: domain.tenantId,
          identitySessionId: input.identitySessionId,
          redirectUri,
          redemptionHost: host,
          codeChallenge: input.codeChallenge,
          codeChallengeMethod: 'S256',
          expiresAt: new Date(t + AUTHORIZATION_CODE_TTL_MS),
          createdAt: now,
        },
      });
      await tx.identitySession.update({
        where: { id: input.identitySessionId },
        data: {
          lastSeenAt: now,
          idleExpiresAt: new Date(Math.min(t + this.idleMs, identity.absolute_expires_at.getTime())),
        },
      });
      return { kind: 'issued', code, redirectUri };
    });
  }

  /**
   * Canje (solo POST, en el dominio de la empresa; el tenant sale del contexto del request).
   * - Uso único atómico: la fila se bloquea (FOR UPDATE) y se marca consumida en la misma transacción que abre
   *   la sesión. Un canje fallido (PKCE, host, expiración) también la consume: no admite reintentos.
   * - Reutilización: si el código ya se consumió, se revoca la sesión emitida con él (RFC 6749 §4.1.2).
   */
  async redeem(input: { code: string; codeVerifier: string; host: string }): Promise<IssuedTokens> {
    const host = normalizeHost(input.host);
    const contextTenant = this.cls.isActive() ? this.cls.get('tenantId') : undefined;
    if (!contextTenant) throw new AppError('FORBIDDEN', 'Operación de empresa sin contexto de tenant', 403);
    if (!host || !OPAQUE_TOKEN_FORMAT.test(input.code) || !CODE_VERIFIER_FORMAT.test(input.codeVerifier)) {
      throw INVALID_GRANT();
    }
    const now = this.clock.now();

    const outcome = await this.db.client.$transaction(async (tx): Promise<RedeemOutcome> => {
      const [row] = await tx.$queryRaw<LockedCode[]>`
        SELECT id, identity_session_id, tenant_id, redirect_uri, redemption_host::text AS redemption_host,
               code_challenge, expires_at, consumed_at, tenant_session_id
          FROM authorization_codes WHERE code_hash = ${sha256(input.code)} FOR UPDATE`;
      if (!row) return { kind: 'invalid' };

      if (row.consumed_at) {
        if (row.tenant_session_id)
          await revokeSessionsInTx(tx, [row.tenant_session_id], 'AUTH_CODE_REUSE', now);
        return { kind: 'reuse', codeId: row.id, revokedSessionId: row.tenant_session_id };
      }
      await tx.authorizationCode.update({ where: { id: row.id }, data: { consumedAt: now } });

      const bound =
        row.expires_at.getTime() > now.getTime() &&
        row.redemption_host === host &&
        row.tenant_id === contextTenant &&
        row.redirect_uri === redirectUriFor(host) &&
        verifyCodeChallenge(input.codeVerifier, row.code_challenge);
      if (!bound) return { kind: 'invalid' };

      const tokens = await this.sessions.openWithinTransaction(
        tx,
        { identitySessionId: row.identity_session_id, host },
        now,
      );
      if (!tokens) return { kind: 'invalid' };
      await tx.authorizationCode.update({
        where: { id: row.id },
        data: { tenantSessionId: tokens.sessionId },
      });
      return { kind: 'issued', tokens };
    });

    if (outcome.kind === 'issued') return outcome.tokens;
    if (outcome.kind === 'reuse') {
      // Evento de seguridad: nunca se registra el código.
      this.logger.warn(
        {
          event: 'auth.authorization_code_reuse',
          codeId: outcome.codeId,
          revokedSessionId: outcome.revokedSessionId,
        },
        'Reutilización de un código de autorización: se revoca la sesión emitida con él',
      );
    }
    throw INVALID_GRANT();
  }
}

function sha256(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(value).digest());
}
