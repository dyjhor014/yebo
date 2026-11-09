import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { buildPostgresUrl } from '../../config/database-urls';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';
import type { PrismaClient } from '../../generated/prisma/client';
import { createPrismaClient } from './create-prisma-client';

/**
 * Cliente con el rol `yebo_platform`: resolver de dominios y health check. Desde ADR-034 NO salta RLS y solo
 * puede leer `tenants` y `tenant_domains` (lista blanca por migración). Pool y credenciales separados. Su
 * importación fuera de los módulos autorizados está prohibida por una regla de ESLint (multitenancy §3).
 * Las futuras operaciones administrativas (Fase 4) recibirán permisos explícitos con RLS activo, nunca BYPASSRLS.
 */
@Injectable()
export class PlatformPrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(ENV) env: Env) {
    this.client = createPrismaClient({
      connectionString: buildPostgresUrl(env, 'platform', env.PG_DATABASE),
      max: Math.max(2, Math.floor(env.PG_POOL_MAX / 2)),
      applicationName: 'yebo-platform',
      txMaxWaitMs: env.PG_TX_MAX_WAIT_MS,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
