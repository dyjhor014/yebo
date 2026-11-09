import { Pool } from 'pg';
import { buildPostgresUrl, type DbConnectionEnv, type DbRole } from '../../src/config/database-urls';

/**
 * Vacía los datos de empresas e identidad (como yebo_owner) antes de una suite. UNA sola lista para todas las suites:
 * al añadir una tabla que referencie a `tenants` o `users`, se añade aquí y ninguna suite se queda atrás.
 * El catálogo comercial (módulos, planes) y el staff de plataforma no se tocan.
 */
export const RESET_TENANT_DATA =
  'TRUNCATE authorization_codes, refresh_tokens, tenant_sessions, identity_sessions, membership_roles, ' +
  'role_permissions, roles, tenant_memberships, tenant_module_overrides, subscriptions, users, permissions, ' +
  'role_templates, tenant_domains, tenants';

/** Roles de EJECUCIÓN (los mismos que usa la API): yebo_owner, yebo_app, yebo_platform, yebo_identity. */
export function testDbUrl(role: DbRole, database: string): string {
  return buildPostgresUrl(process.env as unknown as DbConnectionEnv, role, database);
}

export function testPool(role: DbRole, database: string, max = 10): Pool {
  return new Pool({
    connectionString: testDbUrl(role, database),
    max,
    application_name: `yebo-test-${role}`,
  });
}

/*
 * ROL EXCLUSIVO DE PRUEBAS (ADR-034): `yebo_test_bypass`, con BYPASSRLS, para SEMBRAR datos de varios tenants y
 * comprobar invariantes globales. Sustituye al antiguo uso de `yebo_platform` (que ya no salta RLS).
 * - Solo existe en clústeres de desarrollo y CI; sin acceso a yebo_dev ni a yebo_shadow.
 * - Sus credenciales están en apps/api/.env.test (TEST_PG_BYPASS_*), que solo carga test/support. La API no las
 *   conoce, y su esquema de entorno rechaza cualquier rol que salte RLS.
 * - Sus permisos de tabla los concede global-setup tras migrar; nunca una migración.
 * - Nunca se usa para verificar el comportamiento de la aplicación: solo para preparar y observar.
 */
export function testBypassUrl(database: string): string {
  const user = process.env.TEST_PG_BYPASS_USER;
  const password = process.env.TEST_PG_BYPASS_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'Faltan TEST_PG_BYPASS_USER/TEST_PG_BYPASS_PASSWORD (apps/api/.env.test): scripts/dev/init-env.sh',
    );
  }
  const url = new URL(`postgresql://${process.env.PG_HOST ?? '127.0.0.1'}:${process.env.PG_PORT ?? '5433'}`);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

export function testBypassPool(database: string, max = 4): Pool {
  return new Pool({ connectionString: testBypassUrl(database), max, application_name: 'yebo-test-bypass' });
}

/**
 * Concede al rol de pruebas DML sobre las tablas de `database` (como yebo_owner), salvo el historial de migraciones.
 * Se ejecuta tras migrar: las migraciones no lo nombran nunca (llegan a producción).
 */
export async function grantTestBypass(database: string): Promise<void> {
  const owner = testPool('owner', database, 1);
  try {
    await owner.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO yebo_test_bypass;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO yebo_test_bypass;
      DO $$ BEGIN
        IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
          REVOKE ALL ON "_prisma_migrations" FROM yebo_test_bypass;
        END IF;
      END $$;`);
  } finally {
    await owner.end();
  }
}
