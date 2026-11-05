import { Injectable, Logger } from '@nestjs/common';
import { PlatformPrismaService } from '../../infrastructure/database/platform-prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { normalizeHost } from './host';

/** Tenant resuelto a partir del host. Es lo único que el resto de la aplicación necesita saber de él aquí. */
export interface ResolvedTenant {
  id: string;
  slug: string;
  tradeName: string;
  status: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED';
}

/** TTL corto (multitenancy §2): un cambio de dominio o de estado se refleja en segundos. */
const POSITIVE_TTL_SECONDS = 60;
/** Los hosts desconocidos también se cachean, menos tiempo, para no consultar la BD en cada intento. */
const NEGATIVE_TTL_SECONDS = 15;
const NOT_FOUND = '-';

/**
 * Resuelve host → tenant (ADR-004). Solo los dominios VERIFIED resuelven.
 * Usa yebo_platform porque tenant_domains es global y se consulta ANTES de conocer el tenant.
 * Redis es solo caché: si falla, se consulta PostgreSQL (nunca se rechaza por la caché).
 */
@Injectable()
export class TenantResolverService {
  private readonly logger = new Logger(TenantResolverService.name);

  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly redis: RedisService,
  ) {}

  async resolve(rawHost: string | undefined): Promise<ResolvedTenant | null> {
    const host = normalizeHost(rawHost);
    if (!host) return null;
    const key = cacheKey(host);

    const cached = await this.cacheGet(key);
    if (cached === NOT_FOUND) return null;
    if (cached) return JSON.parse(cached) as ResolvedTenant;

    const domain = await this.platform.client.tenantDomain.findUnique({
      where: { host },
      select: {
        verificationStatus: true,
        tenant: { select: { id: true, slug: true, tradeName: true, status: true } },
      },
    });
    const tenant = domain?.verificationStatus === 'VERIFIED' ? domain.tenant : null;
    await this.cacheSet(
      key,
      tenant ? JSON.stringify(tenant) : NOT_FOUND,
      tenant ? POSITIVE_TTL_SECONDS : NEGATIVE_TTL_SECONDS,
    );
    return tenant;
  }

  /** Para la Fase 4: al cambiar un dominio o el estado de un tenant, se invalida su entrada. */
  async invalidate(rawHost: string): Promise<void> {
    const host = normalizeHost(rawHost);
    if (!host) return;
    try {
      await this.redis.client.del(cacheKey(host));
    } catch (error) {
      this.logger.warn({ err: error, host }, 'No se pudo invalidar la caché del dominio');
    }
  }

  private async cacheGet(key: string): Promise<string | null> {
    try {
      return await this.redis.client.get(key);
    } catch (error) {
      this.logger.warn({ err: error }, 'Caché de dominios no disponible; se consulta PostgreSQL');
      return null;
    }
  }

  private async cacheSet(key: string, value: string, ttl: number): Promise<void> {
    try {
      await this.redis.client.set(key, value, 'EX', ttl);
    } catch (error) {
      this.logger.warn({ err: error }, 'No se pudo escribir la caché de dominios');
    }
  }
}

function cacheKey(host: string): string {
  return `tenant:host:${host}`;
}
