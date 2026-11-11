import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { buildPostgresUrl } from '../../config/database-urls';
import { ENV } from '../../config/env.module';
import { InvalidConfigurationError, type Env } from '../../config/env';
import { createPrismaClient } from '../../infrastructure/database/create-prisma-client';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * Cliente con el rol dedicado `yebo_identity` (Fase 3.2a). Frontera de acceso:
 * - en PostgreSQL: solo SELECT/INSERT/UPDATE sobre las tablas de sesión y SELECT sobre users,
 *   tenant_memberships (política de lectura propia) y tenant_domains; sin BYPASSRLS ni acceso a datos de negocio;
 * - en el código: este proveedor NO se exporta del módulo identity, y una regla de ESLint prohíbe importarlo
 *   fuera de `src/modules/identity/` (ver eslint.config.mjs y la prueba de frontera).
 */
@Injectable()
export class IdentityPrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(ENV) env: Env) {
    if (!env.PG_IDENTITY_PASSWORD) {
      throw new InvalidConfigurationError(['PG_IDENTITY_PASSWORD: obligatoria para el módulo de identidad']);
    }
    this.client = createPrismaClient({
      connectionString: buildPostgresUrl(env, 'identity', env.PG_DATABASE),
      max: Math.max(2, Math.floor(env.PG_POOL_MAX / 2)),
      applicationName: 'yebo-identity',
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
