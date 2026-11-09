import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { buildPostgresUrl } from '../../config/database-urls';
import { ENV } from '../../config/env.module';
import { InvalidConfigurationError, type Env } from '../../config/env';
import { createPrismaClient } from '../../infrastructure/database/create-prisma-client';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * Cliente con el rol `yebo_backoffice` (Fase 4, F4-Q2): la API del superadmin. Frontera de acceso:
 * - en PostgreSQL: permisos explícitos solo sobre las tablas de plataforma (lista blanca por migración, ADR-034),
 *   sin BYPASSRLS;
 * - en el código: NO se exporta del módulo platform-admin, y ESLint prohíbe importarlo fuera de él.
 */
@Injectable()
export class BackofficePrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(ENV) env: Env) {
    if (!env.PG_BACKOFFICE_PASSWORD) {
      throw new InvalidConfigurationError([
        'PG_BACKOFFICE_PASSWORD: obligatoria para el panel de administración',
      ]);
    }
    this.client = createPrismaClient({
      connectionString: buildPostgresUrl(env, 'backoffice', env.PG_DATABASE),
      max: Math.max(2, Math.floor(env.PG_POOL_MAX / 2)),
      applicationName: 'yebo-backoffice',
    });
  }

  /**
   * Transacción con el contexto de UN tenant fijado (ADR-025): para las pocas escrituras del superadmin en tablas de
   * tenant (excepciones de módulo, alta de empresas). El RLS forzado sigue activo: fuera de ese tenant, 0 filas.
   */
  withTenant<T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return this.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
