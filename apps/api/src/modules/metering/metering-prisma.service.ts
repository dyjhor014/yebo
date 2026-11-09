import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { buildPostgresUrl } from '../../config/database-urls';
import { ENV } from '../../config/env.module';
import { InvalidConfigurationError, type Env } from '../../config/env';
import { createPrismaClient } from '../../infrastructure/database/create-prisma-client';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * Cliente con el rol `yebo_metering` (Fase 4.4, F4-Q2): jobs de medición. Sin BYPASSRLS ni políticas entre tenants:
 * cada cálculo fija el contexto de su tenant (decisión del 2026-11-10). Frontera 5 de ESLint: solo se importa dentro
 * de `modules/metering`.
 */
@Injectable()
export class MeteringPrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(ENV) env: Env) {
    if (!env.PG_METERING_PASSWORD) {
      throw new InvalidConfigurationError(['PG_METERING_PASSWORD: obligatoria para el job de medición']);
    }
    this.client = createPrismaClient({
      connectionString: buildPostgresUrl(env, 'metering', env.PG_DATABASE),
      max: 2,
      applicationName: 'yebo-metering',
      txMaxWaitMs: env.PG_TX_MAX_WAIT_MS,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
