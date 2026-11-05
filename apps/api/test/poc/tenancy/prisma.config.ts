import { defineConfig } from 'prisma/config';
import { buildPostgresUrl, type DbConnectionEnv } from '../../../src/config/database-urls';
import { loadEnvFileIfPresent } from '../../../src/config/load-env-file';

loadEnvFileIfPresent(`${__dirname}/../../../.env`);
const env = process.env as unknown as DbConnectionEnv & { PG_SHADOW_DATABASE?: string };
const hasOwner = Boolean(env.PG_OWNER_USER && env.PG_OWNER_PASSWORD && env.PG_HOST);

export default defineConfig({
  schema: `${__dirname}/schema.prisma`,
  migrations: { path: `${__dirname}/migrations` },
  ...(hasOwner && {
    datasource: {
      url: buildPostgresUrl(env, 'owner', 'yebo_poc_tenancy'),
      shadowDatabaseUrl: buildPostgresUrl(env, 'owner', env.PG_SHADOW_DATABASE ?? 'yebo_shadow'),
    },
  }),
});
