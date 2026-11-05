import { defineConfig } from 'prisma/config';
import { buildPostgresUrl, type DbConnectionEnv } from './src/config/database-urls';
import { loadEnvFileIfPresent } from './src/config/load-env-file';

// Prisma CLI (migraciones) se conecta SIEMPRE como propietario (yebo_owner), nunca como yebo_app.
loadEnvFileIfPresent(`${__dirname}/.env`);
const env = process.env as unknown as DbConnectionEnv & { PG_DATABASE?: string; PG_SHADOW_DATABASE?: string };
const hasOwner = Boolean(env.PG_OWNER_USER && env.PG_OWNER_PASSWORD && env.PG_HOST);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate` no necesita conexión; los comandos de migración sí.
  ...(hasOwner && {
    datasource: {
      url: buildPostgresUrl(env, 'owner', env.PG_DATABASE ?? 'yebo_dev'),
      shadowDatabaseUrl: buildPostgresUrl(env, 'owner', env.PG_SHADOW_DATABASE ?? 'yebo_shadow'),
    },
  }),
});
