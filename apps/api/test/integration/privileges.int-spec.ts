/**
 * ADR-034 · Separación efectiva de privilegios de PostgreSQL. Foto de privilegios contra una matriz VERSIONADA:
 * un GRANT olvidado o sobrante en una migración futura rompe esta suite (la prueba de deriva de ADR-024 no ve los
 * GRANT). Comprueba también los atributos de rol, las pertenencias, los privilegios por defecto, el acceso a las
 * bases, las negativas de yebo_platform y que el rol de pruebas no pueda filtrarse a la aplicación.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { Pool as PgPool } from 'pg';
import { AppModule } from '../../src/app.module';
import { AppPrismaService } from '../../src/infrastructure/database/app-prisma.service';
import { PlatformPrismaService } from '../../src/infrastructure/database/platform-prisma.service';
import { IdentityPrismaService } from '../../src/modules/identity/identity-prisma.service';
import { BackofficePrismaService } from '../../src/modules/platform-admin/backoffice-prisma.service';
import { testBypassUrl, testDbUrl, testPool } from '../support/db';

const DB = 'yebo_test';
const API_ROOT = resolve(__dirname, '..', '..');
const RUNTIME = ['yebo_app', 'yebo_platform', 'yebo_identity', 'yebo_backoffice'] as const;

/** Matriz esperada de privilegios de TABLA (explícitos) de los roles de ejecución en el esquema public. */
const EXPECTED_TABLE_GRANTS = [
  'yebo_app membership_roles DELETE,INSERT,SELECT,UPDATE',
  'yebo_app modules SELECT',
  'yebo_app permissions SELECT',
  'yebo_app plan_version_modules SELECT',
  'yebo_app role_permissions DELETE,INSERT,SELECT,UPDATE',
  'yebo_app role_templates SELECT',
  'yebo_app roles DELETE,INSERT,SELECT,UPDATE',
  'yebo_app subscriptions SELECT',
  'yebo_app tenant_memberships SELECT',
  'yebo_app tenant_module_overrides SELECT',
  'yebo_backoffice modules SELECT',
  'yebo_backoffice plan_version_modules DELETE,INSERT,SELECT',
  'yebo_backoffice plan_versions INSERT,SELECT,UPDATE',
  'yebo_backoffice plans INSERT,SELECT,UPDATE',
  'yebo_backoffice platform_audit_logs INSERT,SELECT',
  'yebo_backoffice platform_sessions INSERT,SELECT,UPDATE',
  'yebo_backoffice platform_setup_tokens INSERT,SELECT,UPDATE',
  'yebo_backoffice platform_users INSERT,SELECT,UPDATE',
  'yebo_backoffice subscriptions SELECT',
  'yebo_backoffice tenant_module_overrides INSERT,SELECT,UPDATE',
  'yebo_backoffice tenants SELECT',
  'yebo_identity authorization_codes INSERT,SELECT,UPDATE',
  'yebo_identity identity_sessions INSERT,SELECT,UPDATE',
  'yebo_identity refresh_tokens INSERT,SELECT,UPDATE',
  'yebo_identity tenant_domains SELECT',
  'yebo_identity tenant_memberships SELECT',
  'yebo_identity tenant_sessions INSERT,SELECT,UPDATE',
  'yebo_identity users SELECT',
  'yebo_platform tenant_domains SELECT',
  'yebo_platform tenants SELECT',
];

/** Privilegios de COLUMNA explícitos (Fase 3.3). */
const EXPECTED_COLUMN_GRANTS = [
  'yebo_app tenant_memberships.permissions_version UPDATE',
  'yebo_app tenant_memberships.status UPDATE',
  'yebo_app tenant_memberships.updated_at UPDATE',
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('ADR-034 · separación efectiva de privilegios', () => {
  let app: INestApplication;
  let owner: Pool;

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await owner.end();
  });

  describe('servicios de ejecución', () => {
    it('cada servicio Prisma usa su rol y NINGUNO salta RLS', async () => {
      const whoami = async (client: AppPrismaService['client']) =>
        (
          await client.$queryRaw<{ user: string; bypass: boolean }[]>`
            SELECT current_user::text AS user, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`
        )[0];
      expect(await whoami(app.get(AppPrismaService).client)).toEqual({ user: 'yebo_app', bypass: false });
      expect(await whoami(app.get(PlatformPrismaService).client)).toEqual({
        user: 'yebo_platform',
        bypass: false,
      });
      expect(await whoami(app.get(IdentityPrismaService, { strict: false }).client)).toEqual({
        user: 'yebo_identity',
        bypass: false,
      });
      expect(await whoami(app.get(BackofficePrismaService, { strict: false }).client)).toEqual({
        user: 'yebo_backoffice',
        bypass: false,
      });
    });
  });

  describe('roles (nivel de clúster)', () => {
    it('ningún rol de la aplicación salta RLS, hereda privilegios, es superusuario o crea roles', async () => {
      const { rows } = await owner.query(
        `SELECT rolname, rolbypassrls, rolinherit, rolsuper, rolcreaterole, rolreplication,
                (rolname <> 'yebo_owner' AND rolcreatedb) AS creates_db
           FROM pg_roles WHERE rolname IN ('yebo_owner', 'yebo_app', 'yebo_platform', 'yebo_identity', 'yebo_backoffice') ORDER BY rolname`,
      );
      for (const r of rows) {
        expect(r).toEqual({
          rolname: r.rolname,
          rolbypassrls: false,
          rolinherit: false,
          rolsuper: false,
          rolcreaterole: false,
          rolreplication: false,
          creates_db: false,
        });
      }
      expect(rows).toHaveLength(5);
    });

    it('el rol de pruebas salta RLS pero no hereda, no es superusuario ni crea roles', async () => {
      const { rows } = await owner.query(
        `SELECT rolbypassrls, rolinherit, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'yebo_test_bypass'`,
      );
      expect(rows).toEqual([
        { rolbypassrls: true, rolinherit: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false },
      ]);
    });

    it('ningún rol yebo_* pertenece a otro rol (ni a los predefinidos de PostgreSQL)', async () => {
      const { rows } = await owner.query(
        `SELECT g.rolname AS grp, m.rolname AS mem FROM pg_auth_members am
           JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
          WHERE m.rolname LIKE 'yebo_%' OR g.rolname LIKE 'yebo_%'`,
      );
      expect(rows).toEqual([]);
    });

    it('acceso a las bases: shadow solo para el propietario; el rol de pruebas nunca en desarrollo', async () => {
      const { rows } = await owner.query<{ datname: string; grantee: string }>(
        `SELECT d.datname, coalesce(r.rolname, 'PUBLIC') AS grantee
           FROM pg_database d, aclexplode(d.datacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
          WHERE d.datname LIKE 'yebo_%' AND a.privilege_type = 'CONNECT' AND coalesce(r.rolname, '') <> 'postgres'`,
      );
      const access = (db: string) =>
        rows
          .filter((r) => r.datname === db)
          .map((r) => r.grantee)
          .sort();
      expect(access('yebo_shadow')).toEqual(['yebo_owner']);
      expect(access('yebo_dev')).toEqual([
        'yebo_app',
        'yebo_backoffice',
        'yebo_identity',
        'yebo_owner',
        'yebo_platform',
      ]);
      expect(access('yebo_test')).toEqual([
        'yebo_app',
        'yebo_backoffice',
        'yebo_identity',
        'yebo_owner',
        'yebo_platform',
        'yebo_test_bypass',
      ]);
      for (const db of ['yebo_poc_tenancy', 'yebo_poc_inventory']) {
        expect(access(db)).toEqual(['yebo_app', 'yebo_owner', 'yebo_test_bypass']);
      }
      expect(rows.some((r) => r.grantee === 'PUBLIC')).toBe(false);
    });

    it('conectarse con el rol de pruebas a yebo_dev falla', async () => {
      const pool = new PgPool({ connectionString: testBypassUrl('yebo_dev'), max: 1 });
      try {
        await expect(pool.query('SELECT 1')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await pool.end();
      }
    });
  });

  describe('foto de privilegios de yebo_test (lista blanca por migración)', () => {
    it('privilegios de tabla de los roles de ejecución: exactamente la matriz versionada', async () => {
      const { rows } = await owner.query<{ line: string }>(
        `SELECT r.rolname || ' ' || c.relname || ' ' || string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS line
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
           JOIN pg_roles r ON r.oid = a.grantee
          WHERE n.nspname = 'public' AND r.rolname = ANY($1)
          GROUP BY r.rolname, c.relname ORDER BY 1`,
        [RUNTIME],
      );
      expect(rows.map((r) => r.line)).toEqual(EXPECTED_TABLE_GRANTS);
    });

    it('privilegios de columna explícitos: solo el UPDATE de membresías de la 3.3', async () => {
      const { rows } = await owner.query<{ line: string }>(
        `SELECT r.rolname || ' ' || c.relname || '.' || att.attname || ' ' || a.privilege_type AS line
           FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace,
                aclexplode(att.attacl) a JOIN pg_roles r ON r.oid = a.grantee
          WHERE n.nspname = 'public' AND r.rolname = ANY($1) ORDER BY 1`,
        [RUNTIME],
      );
      expect(rows.map((r) => r.line)).toEqual(EXPECTED_COLUMN_GRANTS);
    });

    it('sin privilegios por defecto para los roles de ejecución ni EXECUTE por defecto para PUBLIC', async () => {
      const { rows } = await owner.query(
        `SELECT d.defaclobjtype, coalesce(r.rolname, 'PUBLIC') AS grantee
           FROM pg_default_acl d, aclexplode(d.defaclacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
          WHERE coalesce(r.rolname, 'PUBLIC') <> 'yebo_owner'`,
      );
      expect(rows).toEqual([]);
    });

    it('sin funciones SECURITY DEFINER en public', async () => {
      const { rows } = await owner.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prosecdef`,
      );
      expect(rows).toEqual([]);
    });

    it('ningún rol de ejecución es propietario de nada', async () => {
      const { rows } = await owner.query(
        `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) <> 'yebo_owner'`,
      );
      expect(rows).toEqual([]);
    });
  });

  describe('negativas', () => {
    it('yebo_platform: solo lee tenants y tenant_domains; no escribe ni lee nada más', async () => {
      const platform = testPool('platform', DB, 1);
      try {
        await expect(platform.query('SELECT count(*) FROM tenants')).resolves.toBeDefined();
        await expect(platform.query('SELECT count(*) FROM tenant_domains')).resolves.toBeDefined();
        for (const sql of [
          "UPDATE tenants SET status = 'ACTIVE'",
          "INSERT INTO tenants (id, slug) VALUES (gen_random_uuid(), 'x')",
          "UPDATE tenant_domains SET verification_status = 'VERIFIED'",
          'DELETE FROM tenant_domains',
          'SELECT 1 FROM users',
          'SELECT 1 FROM tenant_memberships',
          'SELECT 1 FROM roles',
          'SELECT 1 FROM membership_roles',
          'SELECT 1 FROM identity_sessions',
          'SELECT 1 FROM refresh_tokens',
          'SELECT 1 FROM authorization_codes',
          'SELECT 1 FROM _prisma_migrations',
          'SELECT 1 FROM platform_users',
          'SELECT 1 FROM platform_sessions',
        ]) {
          await expect(platform.query(sql)).rejects.toMatchObject({ code: '42501' });
        }
        for (const role of [
          'yebo_app',
          'yebo_owner',
          'yebo_test_bypass',
          'yebo_identity',
          'yebo_backoffice',
        ]) {
          await expect(platform.query(`SET ROLE ${role}`)).rejects.toMatchObject({ code: '42501' });
        }
      } finally {
        await platform.end();
      }
    });

    it('ningún rol de ejecución lee ni escribe el historial de migraciones', async () => {
      for (const role of RUNTIME) {
        const pool = testPool(
          role === 'yebo_app' ? 'app' : role === 'yebo_platform' ? 'platform' : 'identity',
          DB,
          1,
        );
        try {
          await expect(pool.query('SELECT 1 FROM _prisma_migrations')).rejects.toMatchObject({
            code: '42501',
          });
          await expect(pool.query('DELETE FROM _prisma_migrations')).rejects.toMatchObject({ code: '42501' });
        } finally {
          await pool.end();
        }
      }
    });

    it('el rol de pruebas no puede tocar el historial de migraciones', async () => {
      const pool = new PgPool({ connectionString: testBypassUrl(DB), max: 1 });
      try {
        await expect(pool.query('SELECT 1 FROM _prisma_migrations')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await pool.end();
      }
    });
  });

  describe('el rol de pruebas no se filtra a la aplicación ni a producción', () => {
    it('apps/api/src no nombra el rol de pruebas ni sus variables', () => {
      const offenders = walk(resolve(API_ROOT, 'src'))
        .filter((f) => !f.includes(`${'/'}generated${'/'}`))
        .filter((f) => /yebo_test_bypass|TEST_PG_BYPASS/.test(readFileSync(f, 'utf8')));
      expect(offenders).toEqual([]);
    });

    it('ninguna migración (llegan a producción) nombra el rol de pruebas', () => {
      const offenders = walk(resolve(API_ROOT, 'prisma', 'migrations')).filter((f) =>
        readFileSync(f, 'utf8').includes('yebo_test_bypass'),
      );
      expect(offenders).toEqual([]);
    });

    it('la plantilla de configuración de la API no incluye credenciales del rol de pruebas', () => {
      expect(readFileSync(resolve(API_ROOT, '.env.example'), 'utf8')).not.toMatch(/TEST_PG_BYPASS|bypass/i);
    });

    it('la URL del rol de pruebas no coincide con la de ningún rol de ejecución', () => {
      const urls = (['app', 'platform', 'identity', 'owner'] as const).map(
        (r) => new URL(testDbUrl(r, DB)).username,
      );
      expect(urls).not.toContain(new URL(testBypassUrl(DB)).username);
    });
  });
});
