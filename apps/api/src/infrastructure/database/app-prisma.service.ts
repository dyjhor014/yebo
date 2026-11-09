import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { buildPostgresUrl } from '../../config/database-urls';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';
import type { PrismaClient } from '../../generated/prisma/client';
import { createPrismaClient } from './create-prisma-client';

/**
 * Cliente con el rol `yebo_app`: RLS APLICA (ADR-003).
 * Los módulos de negocio no lo usan directamente: usan TenantDbService, que añade las dos barreras.
 */
@Injectable()
export class AppPrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(ENV) env: Env) {
    this.client = createPrismaClient({
      connectionString: buildPostgresUrl(env, 'app', env.PG_DATABASE),
      max: env.PG_POOL_MAX,
      applicationName: 'yebo-app',
      txMaxWaitMs: env.PG_TX_MAX_WAIT_MS,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
