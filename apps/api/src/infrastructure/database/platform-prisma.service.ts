import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { buildPostgresUrl } from '../../config/database-urls';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';
import type { PrismaClient } from '../../generated/prisma/client';
import { createPrismaClient } from './create-prisma-client';

/**
 * Cliente con el rol `yebo_platform` (BYPASSRLS): resolver de dominios, identidad, superadmin
 * y jobs entre tenants. Pool y credenciales separados. Su importación desde módulos de negocio
 * está prohibida por una regla de ESLint (multitenancy §3).
 */
@Injectable()
export class PlatformPrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(ENV) env: Env) {
    this.client = createPrismaClient({
      connectionString: buildPostgresUrl(env, 'platform', env.PG_DATABASE),
      max: Math.max(2, Math.floor(env.PG_POOL_MAX / 2)),
      applicationName: 'yebo-platform',
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
