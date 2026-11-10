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
const RUNTIME = ['yebo_app', 'yebo_platform', 'yebo_identity', 'yebo_backoffice', 'yebo_metering'] as const;

/** Matriz esperada de privilegios de TABLA (explícitos) de los roles de ejecución en el esquema public. */
const EXPECTED_TABLE_GRANTS = [
  'yebo_app billing_periods SELECT',
  'yebo_app file_assets INSERT,SELECT',
  'yebo_app membership_invitations INSERT,SELECT',
  'yebo_app membership_roles DELETE,INSERT,SELECT,UPDATE',
  'yebo_app membership_status_history INSERT,SELECT',
  'yebo_app modules SELECT',
  'yebo_app permissions SELECT',
  'yebo_app plan_version_modules SELECT',
  'yebo_app platform_invoice_lines SELECT',
  'yebo_app platform_invoices SELECT',
  'yebo_app role_permissions DELETE,INSERT,SELECT,UPDATE',
  'yebo_app role_templates SELECT',
  'yebo_app roles DELETE,INSERT,SELECT,UPDATE',
  'yebo_app site_versions INSERT,SELECT',
  'yebo_app subscription_payments SELECT',
  'yebo_app subscriptions SELECT',
  'yebo_app support_access_grants SELECT',
  'yebo_app support_access_logs SELECT',
  'yebo_app tenant_memberships SELECT',
  'yebo_app tenant_module_overrides SELECT',
  'yebo_app tenant_operation_overrides SELECT',
  'yebo_app tenant_services SELECT',
  'yebo_app tenant_settings SELECT',
  'yebo_app tenant_status_history SELECT',
  'yebo_app usage_daily_snapshots SELECT',
  'yebo_app usage_period_calculations SELECT',
  'yebo_backoffice billing_periods INSERT,SELECT',
  'yebo_backoffice file_assets SELECT',
  'yebo_backoffice membership_invitations INSERT,SELECT',
  'yebo_backoffice membership_status_history SELECT',
  'yebo_backoffice modules SELECT',
  'yebo_backoffice permissions SELECT',
  'yebo_backoffice plan_version_modules DELETE,INSERT,SELECT',
  'yebo_backoffice plan_versions INSERT,SELECT,UPDATE',
  'yebo_backoffice plans INSERT,SELECT,UPDATE',
  'yebo_backoffice platform_audit_logs INSERT,SELECT',
  'yebo_backoffice platform_invoice_lines SELECT',
  'yebo_backoffice platform_invoices SELECT',
  'yebo_backoffice platform_sessions INSERT,SELECT,UPDATE',
  'yebo_backoffice platform_setup_tokens INSERT,SELECT,UPDATE',
  'yebo_backoffice platform_users INSERT,SELECT,UPDATE',
  'yebo_backoffice role_permissions INSERT',
  'yebo_backoffice role_templates SELECT',
  'yebo_backoffice roles INSERT,SELECT',
  'yebo_backoffice site_versions SELECT',
  'yebo_backoffice subscription_payments INSERT,SELECT',
  'yebo_backoffice subscriptions INSERT,SELECT',
  'yebo_backoffice support_access_grants INSERT,SELECT',
  'yebo_backoffice support_access_logs INSERT,SELECT',
  'yebo_backoffice support_handoffs INSERT,SELECT',
  'yebo_backoffice support_sessions INSERT,SELECT',
  'yebo_backoffice tenant_domains INSERT,SELECT',
  'yebo_backoffice tenant_module_overrides INSERT,SELECT,UPDATE',
  'yebo_backoffice tenant_operation_overrides INSERT,SELECT,UPDATE',
  'yebo_backoffice tenant_services INSERT,SELECT',
  'yebo_backoffice tenant_settings INSERT,SELECT',
  'yebo_backoffice tenant_status_history INSERT,SELECT',
  'yebo_backoffice tenants INSERT,SELECT',
  'yebo_backoffice usage_daily_snapshots SELECT',
  'yebo_backoffice usage_period_calculations SELECT',
  'yebo_identity authorization_codes INSERT,SELECT,UPDATE',
  'yebo_identity identity_sessions INSERT,SELECT,UPDATE',
  'yebo_identity membership_invitations SELECT',
  'yebo_identity membership_roles INSERT,SELECT',
  'yebo_identity membership_status_history INSERT,SELECT',
  'yebo_identity refresh_tokens INSERT,SELECT,UPDATE',
  'yebo_identity roles SELECT',
  'yebo_identity tenant_domains SELECT',
  'yebo_identity tenant_memberships INSERT,SELECT',
  'yebo_identity tenant_operation_overrides SELECT',
  'yebo_identity tenant_sessions INSERT,SELECT,UPDATE',
  'yebo_identity users INSERT,SELECT',
  'yebo_metering billing_periods INSERT,SELECT',
  'yebo_metering membership_status_history SELECT',
  'yebo_metering plan_versions SELECT',
  'yebo_metering platform_invoice_lines INSERT,SELECT',
  'yebo_metering platform_invoices INSERT,SELECT',
  'yebo_metering subscriptions INSERT,SELECT',
  'yebo_metering tenants SELECT',
  'yebo_metering usage_daily_snapshots INSERT,SELECT',
  'yebo_metering usage_period_calculations INSERT,SELECT',
  'yebo_platform tenant_domains SELECT',
  'yebo_platform tenants SELECT',
];

/** Privilegios de COLUMNA explícitos (Fase 3.3). */
const EXPECTED_COLUMN_GRANTS = [
  'yebo_app file_assets.status UPDATE',
  'yebo_app membership_invitations.revoked_at UPDATE',
  'yebo_app membership_status_history.valid_to UPDATE',
  'yebo_app site_versions.config UPDATE',
  'yebo_app site_versions.live_slot UPDATE',
  'yebo_app site_versions.published_at UPDATE',
  'yebo_app site_versions.published_by_id UPDATE',
  'yebo_app site_versions.published_by_kind UPDATE',
  'yebo_app site_versions.schema_version UPDATE',
  'yebo_app site_versions.status UPDATE',
  'yebo_app site_versions.updated_at UPDATE',
  'yebo_app support_access_grants.approved_at UPDATE',
  'yebo_app support_access_grants.approved_by_membership_id UPDATE',
  'yebo_app support_access_grants.revoked_at UPDATE',
  'yebo_app support_access_grants.revoked_by_id UPDATE',
  'yebo_app support_access_grants.revoked_by_kind UPDATE',
  'yebo_app tenant_memberships.permissions_version UPDATE',
  'yebo_app tenant_memberships.status UPDATE',
  'yebo_app tenant_memberships.updated_at UPDATE',
  'yebo_app tenant_settings.support_requires_approval UPDATE',
  'yebo_app tenant_settings.updated_at UPDATE',
  'yebo_backoffice billing_periods.cut_off UPDATE',
  'yebo_backoffice platform_invoices.balance UPDATE',
  'yebo_backoffice platform_invoices.status UPDATE',
  'yebo_backoffice platform_invoices.updated_at UPDATE',
  'yebo_backoffice subscription_payments.reversal_reason UPDATE',
  'yebo_backoffice subscription_payments.reversed_at UPDATE',
  'yebo_backoffice subscription_payments.reversed_by_platform_user_id UPDATE',
  'yebo_backoffice subscription_payments.status UPDATE',
  'yebo_backoffice subscriptions.is_current UPDATE',
  'yebo_backoffice subscriptions.next_plan_version_id UPDATE',
  'yebo_backoffice subscriptions.status UPDATE',
  'yebo_backoffice subscriptions.updated_at UPDATE',
  'yebo_backoffice support_access_grants.revoked_at UPDATE',
  'yebo_backoffice support_access_grants.revoked_by_id UPDATE',
  'yebo_backoffice support_access_grants.revoked_by_kind UPDATE',
  'yebo_backoffice support_handoffs.consumed_at UPDATE',
  'yebo_backoffice support_sessions.idle_expires_at UPDATE',
  'yebo_backoffice support_sessions.last_seen_at UPDATE',
  'yebo_backoffice support_sessions.revoked_at UPDATE',
  'yebo_backoffice tenants.activated_at UPDATE',
  'yebo_backoffice tenants.cancelled_at UPDATE',
  'yebo_backoffice tenants.status UPDATE',
  'yebo_backoffice tenants.status_changed_at UPDATE',
  'yebo_backoffice tenants.trial_ends_at UPDATE',
  'yebo_backoffice tenants.updated_at UPDATE',
  'yebo_identity membership_invitations.accepted_at UPDATE',
  'yebo_identity membership_invitations.accepted_membership_id UPDATE',
  'yebo_identity membership_status_history.valid_to UPDATE',
  'yebo_identity tenant_memberships.permissions_version UPDATE',
  'yebo_identity tenant_memberships.status UPDATE',
  'yebo_identity tenant_memberships.updated_at UPDATE',
  'yebo_metering billing_periods.closed_at UPDATE',
  'yebo_metering billing_periods.status UPDATE',
  'yebo_metering subscriptions.current_period_end UPDATE',
  'yebo_metering subscriptions.current_period_start UPDATE',
  'yebo_metering subscriptions.is_current UPDATE',
  'yebo_metering subscriptions.next_plan_version_id UPDATE',
  'yebo_metering subscriptions.updated_at UPDATE',
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
           FROM pg_roles WHERE rolname IN ('yebo_owner', 'yebo_app', 'yebo_platform', 'yebo_identity', 'yebo_backoffice', 'yebo_metering') ORDER BY rolname`,
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
      expect(rows).toHaveLength(6);
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
        'yebo_metering',
        'yebo_owner',
        'yebo_platform',
      ]);
      expect(access('yebo_test')).toEqual([
        'yebo_app',
        'yebo_backoffice',
        'yebo_identity',
        'yebo_metering',
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

    it('privilegios de columna explícitos: membresías, estados, invitaciones, historial, facturación, soporte, anulación de pagos, sitio y archivos (3.3–5.2)', async () => {
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
          'yebo_metering',
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
