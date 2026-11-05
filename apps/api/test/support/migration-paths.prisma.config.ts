import { defineConfig } from 'prisma/config';
import { buildPostgresUrl, type DbConnectionEnv } from '../../src/config/database-urls';
import { loadEnvFileIfPresent } from '../../src/config/load-env-file';

/**
 * Configuración de Prisma CLI SOLO para test/integration/migration-paths.int-spec.ts.
 * Aplica cualquier conjunto de migraciones (completo o parcial) sobre la base desechable `yebo_migrations`,
 * siempre como propietario (yebo_owner).
 */
loadEnvFileIfPresent(`${__dirname}/../../.env`);
const env = process.env as unknown as DbConnectionEnv & {
  MIGRATION_TEST_SCHEMA?: string;
  MIGRATION_TEST_MIGRATIONS?: string;
};
const hasOwner = Boolean(env.PG_OWNER_USER && env.PG_OWNER_PASSWORD && env.PG_HOST);

export default defineConfig({
  schema: env.MIGRATION_TEST_SCHEMA ?? `${__dirname}/../../prisma/schema.prisma`,
  migrations: { path: env.MIGRATION_TEST_MIGRATIONS ?? `${__dirname}/../../prisma/migrations` },
  ...(hasOwner && { datasource: { url: buildPostgresUrl(env, 'owner', 'yebo_migrations') } }),
});
