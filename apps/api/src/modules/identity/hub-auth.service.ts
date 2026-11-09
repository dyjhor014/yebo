import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { IdentityPrismaService } from './identity-prisma.service';
import { PasswordHasher } from './password-hasher';
import { RateLimiterService } from './rate-limiter.service';
import { SessionService } from './session.service';

/** Límites del login (security.md §1). Ventana de 15 minutos. */
export const LOGIN_LIMITS = {
  windowSeconds: 900,
  /** Intentos por IP (todos, correctos o no). */
  perIp: 30,
  /** Fallos por cuenta (se cuenta igual exista o no la cuenta: no permite enumerar). */
  failuresPerAccount: 5,
} as const;

/** Respuesta ÚNICA para cuenta inexistente, contraseña errónea o cuenta no activa (anti-enumeración). */
const INVALID_CREDENTIALS = (): AppError =>
  new AppError('UNAUTHENTICATED', 'Correo o contraseña incorrectos', 401);
const TOO_MANY = (): AppError =>
  new AppError('RATE_LIMITED', 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo', 429);

export interface HubMembership {
  tenantId: string;
  tradeName: string;
  host: string;
}

/** Autenticación en el hub de cuentas: el único lugar donde se escriben credenciales (ADR-022). */
@Injectable()
export class HubAuthService {
  constructor(
    private readonly db: IdentityPrismaService,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiterService,
    private readonly sessions: SessionService,
    private readonly tenants: TenantResolverService,
  ) {}

  async login(input: {
    email: string;
    password: string;
    ip: string;
    userAgent?: string;
  }): Promise<{ identitySessionId: string; absoluteExpiresAt: Date }> {
    const email = input.email.trim().toLowerCase();
    const accountKey = `login:acct:${createHash('sha256').update(email).digest('base64url')}`;

    if (
      !(await this.limiter.hit(`login:ip:${input.ip}`, LOGIN_LIMITS.perIp, LOGIN_LIMITS.windowSeconds))
        .allowed
    ) {
      throw TOO_MANY();
    }
    if ((await this.limiter.count(accountKey)) >= LOGIN_LIMITS.failuresPerAccount) throw TOO_MANY();

    const user = await this.db.client.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, status: true },
    });
    // Mismo coste de cálculo exista o no la cuenta (verifyDummy), y misma respuesta en todos los fallos.
    const valid = user
      ? await this.hasher.verify(user.passwordHash, input.password)
      : await this.hasher.verifyDummy(input.password);
    if (!user || !valid || user.status !== 'ACTIVE') {
      await this.limiter.hit(accountKey, LOGIN_LIMITS.failuresPerAccount, LOGIN_LIMITS.windowSeconds);
      throw INVALID_CREDENTIALS();
    }
    await this.limiter.reset(accountKey);

    const session = await this.sessions.createIdentitySession({
      userId: user.id,
      authMethods: ['pwd'],
      ip: input.ip,
      ...(input.userAgent !== undefined && { userAgent: input.userAgent }),
    });
    return { identitySessionId: session.id, absoluteExpiresAt: session.absoluteExpiresAt };
  }

  /** Empresas del propio usuario (selector de empresa y pantalla "sin acceso"): solo membresías ACTIVE. */
  async listMemberships(userId: string): Promise<HubMembership[]> {
    const memberships = await this.db.client.tenantMembership.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { tenantId: true },
    });
    if (memberships.length === 0) return [];
    const tenantIds = memberships.map((m) => m.tenantId);
    const domains = await this.db.client.tenantDomain.findMany({
      where: { tenantId: { in: tenantIds }, isPrimary: true, verificationStatus: 'VERIFIED' },
      select: { tenantId: true, host: true },
    });
    const names = await this.tenants.describe(tenantIds);
    return domains
      .map((d) => ({ tenantId: d.tenantId, host: d.host, tradeName: names.get(d.tenantId) ?? '' }))
      .filter((m) => m.tradeName !== '')
      .sort((a, b) => a.tradeName.localeCompare(b.tradeName, 'es'));
  }
}
