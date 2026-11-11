/**
 * Construcción de cadenas de conexión a PostgreSQL por rol (ADR-003).
 * Se comparte entre la API, el worker, la configuración de Prisma CLI y las pruebas.
 */
export type DbRole = 'app' | 'platform' | 'owner' | 'identity';

export interface DbConnectionEnv {
  PG_HOST: string;
  PG_PORT: number | string;
  PG_APP_USER: string;
  PG_APP_PASSWORD: string;
  PG_PLATFORM_USER: string;
  PG_PLATFORM_PASSWORD: string;
  PG_OWNER_USER?: string | undefined;
  PG_OWNER_PASSWORD?: string | undefined;
  PG_IDENTITY_USER?: string | undefined;
  PG_IDENTITY_PASSWORD?: string | undefined;
}

export function buildPostgresUrl(env: DbConnectionEnv, role: DbRole, database: string): string {
  const credentials: Record<DbRole, [string | undefined, string | undefined]> = {
    app: [env.PG_APP_USER, env.PG_APP_PASSWORD],
    platform: [env.PG_PLATFORM_USER, env.PG_PLATFORM_PASSWORD],
    owner: [env.PG_OWNER_USER, env.PG_OWNER_PASSWORD],
    identity: [env.PG_IDENTITY_USER, env.PG_IDENTITY_PASSWORD],
  };
  const [user, password] = credentials[role];
  if (!user || !password) {
    throw new Error(`Faltan las credenciales de PostgreSQL para el rol "${role}"`);
  }
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${env.PG_HOST}:${env.PG_PORT}/${encodeURIComponent(database)}`;
}
