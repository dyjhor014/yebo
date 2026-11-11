import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';
import type { PlatformRole, PlatformSessionRevokeReason } from '../../generated/prisma/client';
import { Clock } from '../identity/clock';
import { PASSWORD_MAX_LENGTH, PasswordHasher } from '../identity/password-hasher';
import { RateLimiterService } from '../identity/rate-limiter.service';
import { BackofficePrismaService } from './backoffice-prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import { PLATFORM_ROLE_PERMISSIONS, type PlatformPermission } from './platform-permissions';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp';

export const PLATFORM_PASSWORD_MIN_LENGTH = 12;
/** Validez del enlace de configuración de contraseña (alta o restablecimiento de un miembro del staff). */
export const SETUP_TOKEN_TTL_HOURS = 24;
const LOGIN_LIMITS = { perIp: 30, failuresPerAccount: 5, windowSeconds: 15 * 60 } as const;
const MFA_LIMITS = { failuresPerUser: 5, windowSeconds: 15 * 60 } as const;
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
const UUID = z.uuid();

const INVALID_CREDENTIALS = () => new AppError('UNAUTHENTICATED', 'Correo o contraseña incorrectos', 401);
const INVALID_CODE = () => new AppError('UNAUTHENTICATED', 'El código no es válido', 401);
const TOO_MANY = () => new AppError('RATE_LIMITED', 'Demasiados intentos. Espera unos minutos', 429);

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface PlatformPrincipal {
  sessionId: string;
  platformUserId: string;
  email: string;
  fullName: string;
  role: PlatformRole;
  permissions: ReadonlySet<PlatformPermission>;
}

export interface IssuedPlatformSession {
  token: string;
  absoluteExpiresAt: Date;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
export const newOpaqueToken = (): string => randomBytes(32).toString('base64url');
const mfaAad = (platformUserId: string) => `platform_users.mfa_secret:${platformUserId}`;

/**
 * Autenticación del staff de YEBO (Fase 4.1). Realm propio, separado del hub de clientes:
 *  1. contraseña (Argon2id, respuesta y coste uniformes, límites por IP y por cuenta);
 *  2. MFA TOTP OBLIGATORIO (security.md §1): alta en el primer acceso o verificación; un código no se reutiliza;
 *  3. sesión opaca de 256 bits (cookie `__Host-yebo_admin`), verificada en PostgreSQL en cada petición, con caducidad
 *     por inactividad y absoluta más cortas que las de clientes.
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly db: BackofficePrismaService,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiterService,
    private readonly encryption: FieldEncryption,
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // Paso 1 · contraseña
  // ---------------------------------------------------------------------------------------------------------------

  /** Devuelve el siguiente paso de MFA; nunca abre sesión por sí solo. */
  async login(
    input: { email: string; password: string },
    meta: RequestMeta,
  ): Promise<{ platformUserId: string; next: 'MFA_VERIFY' | 'MFA_ENROLL' }> {
    const email = input.email.trim().toLowerCase();
    const accountKey = `plogin:acct:${createHash('sha256').update(email).digest('base64url')}`;
    if (
      !(
        await this.limiter.hit(
          `plogin:ip:${meta.ip ?? 'desconocida'}`,
          LOGIN_LIMITS.perIp,
          LOGIN_LIMITS.windowSeconds,
        )
      ).allowed
    ) {
      throw TOO_MANY();
    }
    if ((await this.limiter.count(accountKey)) >= LOGIN_LIMITS.failuresPerAccount) throw TOO_MANY();

    const user = await this.db.client.platformUser.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, status: true, mfaEnabledAt: true },
    });
    // Mismo coste exista o no la cuenta, y la misma respuesta en todos los fallos (sin enumeración).
    const valid = user?.passwordHash
      ? await this.hasher.verify(user.passwordHash, input.password)
      : await this.hasher.verifyDummy(input.password);
    if (!user || !valid || user.status !== 'ACTIVE') {
      await this.limiter.hit(accountKey, LOGIN_LIMITS.failuresPerAccount, LOGIN_LIMITS.windowSeconds);
      throw INVALID_CREDENTIALS();
    }
    await this.limiter.reset(accountKey);
    return { platformUserId: user.id, next: user.mfaEnabledAt ? 'MFA_VERIFY' : 'MFA_ENROLL' };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Paso 2 · MFA
  // ---------------------------------------------------------------------------------------------------------------

  /** Genera (o regenera, mientras no esté activada) el secreto TOTP. El secreto se muestra una sola vez. */
  async enrollMfa(platformUserId: string): Promise<{ otpauthUri: string; secret: string }> {
    const user = await this.activeUser(platformUserId);
    if (user.mfaEnabledAt)
      throw new AppError('CONFLICT', 'La verificación en dos pasos ya está activada', 409);
    const secret = newTotpSecret();
    const encrypted = this.encryption.encrypt(secret, mfaAad(user.id));
    await this.db.client.platformUser.updateMany({
      where: { id: user.id, mfaEnabledAt: null },
      data: {
        mfaSecretCiphertext: new Uint8Array(encrypted.ciphertext),
        mfaKeyVersion: encrypted.keyVersion,
        mfaLastStep: null,
      },
    });
    const uri = otpauthUri(secret, user.email);
    return { otpauthUri: uri, secret: new URL(uri).searchParams.get('secret') ?? '' };
  }

  /** Activa la MFA con el primer código válido y abre la sesión. */
  async activateMfa(platformUserId: string, code: string, meta: RequestMeta): Promise<IssuedPlatformSession> {
    return this.completeMfa(platformUserId, code, meta, 'activate');
  }

  /** Verifica el código de una MFA ya activada y abre la sesión. */
  async verifyMfa(platformUserId: string, code: string, meta: RequestMeta): Promise<IssuedPlatformSession> {
    return this.completeMfa(platformUserId, code, meta, 'verify');
  }

  private async completeMfa(
    platformUserId: string,
    code: string,
    meta: RequestMeta,
    mode: 'activate' | 'verify',
  ): Promise<IssuedPlatformSession> {
    const failuresKey = `pmfa:user:${platformUserId}`;
    if ((await this.limiter.count(failuresKey)) >= MFA_LIMITS.failuresPerUser) throw TOO_MANY();
    const user = await this.activeUser(platformUserId);
    const enabled = user.mfaEnabledAt !== null;
    if ((mode === 'activate') === enabled || !user.mfaSecretCiphertext || user.mfaKeyVersion === null) {
      throw new AppError('CONFLICT', 'El paso de verificación no corresponde al estado de la cuenta', 409);
    }
    const secret = this.encryption.decrypt(
      { ciphertext: Buffer.from(user.mfaSecretCiphertext), keyVersion: user.mfaKeyVersion },
      mfaAad(user.id),
    );
    const now = this.clock.now();
    const lastStep = user.mfaLastStep === null ? null : Number(user.mfaLastStep);
    const step = verifyTotp(secret, code, now, lastStep);
    if (step === null) {
      await this.limiter.hit(failuresKey, MFA_LIMITS.failuresPerUser, MFA_LIMITS.windowSeconds);
      throw INVALID_CODE();
    }
    return this.db.client.$transaction(async (tx) => {
      // Consumo atómico del paso: dos peticiones con el mismo código no pueden ganar las dos.
      const consumed = await tx.platformUser.updateMany({
        where: {
          id: user.id,
          status: 'ACTIVE',
          OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: BigInt(step) } }],
        },
        data: {
          mfaLastStep: BigInt(step),
          lastLoginAt: now,
          ...(mode === 'activate' && { mfaEnabledAt: now }),
        },
      });
      if (consumed.count !== 1) throw INVALID_CODE();
      await this.limiter.reset(failuresKey);
      const session = await this.openSession(tx, user.id, meta, now);
      if (mode === 'activate') {
        await this.audit.record({ platformUserId: user.id, action: 'staff.mfa_enabled', ...ipOf(meta) }, tx);
      }
      await this.audit.record(
        {
          platformUserId: user.id,
          action: 'staff.login',
          targetType: 'platform_session',
          targetId: session.id,
          ...ipOf(meta),
        },
        tx,
      );
      return { token: session.token, absoluteExpiresAt: session.absoluteExpiresAt };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Sesiones
  // ---------------------------------------------------------------------------------------------------------------

  private async openSession(
    tx: Pick<BackofficePrismaService['client'], 'platformSession'>,
    platformUserId: string,
    meta: RequestMeta,
    now: Date,
  ): Promise<{ id: string; token: string; absoluteExpiresAt: Date }> {
    const token = newOpaqueToken();
    const absoluteExpiresAt = new Date(now.getTime() + this.env.PLATFORM_SESSION_ABSOLUTE_HOURS * 3_600_000);
    const idleExpiresAt = this.idleExpiry(now, absoluteExpiresAt);
    const session = await tx.platformSession.create({
      data: {
        platformUserId,
        tokenHash: new Uint8Array(sha256(token)),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
        lastSeenAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
      },
      select: { id: true },
    });
    return { id: session.id, token, absoluteExpiresAt };
  }

  /**
   * Verifica la sesión del staff (en cada petición, en PostgreSQL): sesión vigente, usuario ACTIVE y MFA activada.
   * Renueva la caducidad por inactividad como mucho una vez por minuto.
   */
  async checkSession(token: string | undefined): Promise<PlatformPrincipal | null> {
    if (!token || token.length > 128) return null;
    const now = this.clock.now();
    const session = await this.db.client.platformSession.findUnique({
      where: { tokenHash: new Uint8Array(sha256(token)) },
      select: {
        id: true,
        revokedAt: true,
        idleExpiresAt: true,
        absoluteExpiresAt: true,
        lastSeenAt: true,
        platformUser: {
          select: { id: true, email: true, fullName: true, role: true, status: true, mfaEnabledAt: true },
        },
      },
    });
    if (
      !session ||
      session.revokedAt ||
      session.idleExpiresAt <= now ||
      session.absoluteExpiresAt <= now ||
      session.platformUser.status !== 'ACTIVE' ||
      !session.platformUser.mfaEnabledAt
    ) {
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() >= LAST_SEEN_WRITE_INTERVAL_MS) {
      await this.db.client.platformSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { lastSeenAt: now, idleExpiresAt: this.idleExpiry(now, session.absoluteExpiresAt) },
      });
    }
    const user = session.platformUser;
    return {
      sessionId: session.id,
      platformUserId: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      permissions: new Set(PLATFORM_ROLE_PERMISSIONS[user.role]),
    };
  }

  async logout(principal: PlatformPrincipal, meta: RequestMeta): Promise<void> {
    await this.db.client.$transaction(async (tx) => {
      await this.revokeSessions(tx, { id: principal.sessionId }, 'LOGOUT');
      await this.audit.record(
        { platformUserId: principal.platformUserId, action: 'staff.logout', ...ipOf(meta) },
        tx,
      );
    });
  }

  /** Revoca sesiones vigentes que cumplan el filtro (dentro de la transacción de quien llama). */
  async revokeSessions(
    tx: Pick<BackofficePrismaService['client'], 'platformSession'>,
    where: { id?: string; platformUserId?: string },
    reason: PlatformSessionRevokeReason,
  ): Promise<number> {
    const result = await tx.platformSession.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokeReason: reason },
    });
    return result.count;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Contraseña con enlace de un solo uso
  // ---------------------------------------------------------------------------------------------------------------

  /** Fija la contraseña con un enlace de configuración. Cierra todas las sesiones de la persona. */
  async setupPassword(token: string, password: string, meta: RequestMeta): Promise<void> {
    if (password.length < PLATFORM_PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      throw new AppError(
        'VALIDATION_FAILED',
        `La contraseña debe tener entre ${PLATFORM_PASSWORD_MIN_LENGTH} y ${PASSWORD_MAX_LENGTH} caracteres`,
        400,
      );
    }
    if (!token || token.length > 128) throw INVALID_SETUP();
    // El hash se calcula fuera de la transacción (Argon2id es caro y no debe retener conexiones).
    const passwordHash = await this.hasher.hash(password);
    const now = this.clock.now();
    await this.db.client.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string; platform_user_id: string }[]>`
        SELECT t.id, t.platform_user_id FROM platform_setup_tokens t
          JOIN platform_users u ON u.id = t.platform_user_id
         WHERE t.token_hash = ${sha256(token)} AND t.consumed_at IS NULL AND t.expires_at > ${now}
           AND u.status = 'ACTIVE'
           FOR UPDATE OF t`;
      if (!row) throw INVALID_SETUP();
      await tx.platformSetupToken.update({ where: { id: row.id }, data: { consumedAt: now } });
      await tx.platformUser.update({
        where: { id: row.platform_user_id },
        data: { passwordHash, passwordChangedAt: now },
      });
      await this.revokeSessions(tx, { platformUserId: row.platform_user_id }, 'ADMIN_REVOKED');
      await this.audit.record(
        { platformUserId: row.platform_user_id, action: 'staff.password_set', ...ipOf(meta) },
        tx,
      );
    });
  }

  private async activeUser(platformUserId: string) {
    if (!UUID.safeParse(platformUserId).success) throw INVALID_CODE();
    const user = await this.db.client.platformUser.findUnique({
      where: { id: platformUserId },
      select: {
        id: true,
        email: true,
        status: true,
        mfaEnabledAt: true,
        mfaSecretCiphertext: true,
        mfaKeyVersion: true,
        mfaLastStep: true,
      },
    });
    if (!user || user.status !== 'ACTIVE') throw INVALID_CODE();
    return user;
  }

  private idleExpiry(now: Date, absolute: Date): Date {
    const idle = new Date(now.getTime() + this.env.PLATFORM_SESSION_IDLE_MINUTES * 60_000);
    return idle < absolute ? idle : absolute;
  }
}

const INVALID_SETUP = () =>
  new AppError('UNAUTHENTICATED', 'El enlace no es válido o caducó. Pide uno nuevo', 401);

export function ipOf(meta: RequestMeta): { ip?: string } {
  return meta.ip ? { ip: meta.ip } : {};
}

export const hashSetupToken = sha256;
