/**
 * Caminos de migración (requisito de cierre de la Fase 2, ADR-024 y ADR-025).
 *  1. Desde una base de datos VACÍA: `prisma migrate deploy` aplica todo, el estado queda al día,
 *     la base real no difiere del esquema Prisma y todas las tablas de tenant quedan con RLS forzado y NULLIF.
 *  2. Desde el ESQUEMA ANTERIOR con datos: se aplican solo las migraciones previas a ADR-024/025, se siembran
 *     datos, se aplican las migraciones nuevas y se comprueba que los datos se conservan y el aislamiento mejora.
 * Usa la base desechable `yebo_migrations`, que se vacía al inicio de cada escenario.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { GLOBAL_TABLES_WITH_TENANT_ID } from '../../src/infrastructure/database/tenant-scoped-models';
import { grantTestBypass, testBypassPool, testPool } from '../support/db';

const API_ROOT = resolve(__dirname, '..', '..');
const PRISMA_CLI = require.resolve('prisma/build/index.js', { paths: [API_ROOT] });
const CONFIG = 'test/support/migration-paths.prisma.config.ts';
const DB = 'yebo_migrations';
const A = '0190f0a0-0000-7000-8000-00000000000a';
const B = '0190f0a0-0000-7000-8000-00000000000b';

interface MigrationSet {
  name: string;
  schema: string;
  migrations: string;
  /** Tablas con tenant_id que deben quedar con RLS forzado (vacío en producción: aún no hay tablas). */
  tenantTables: string[];
  /** Tablas globales con tenant_id (multitenancy §4.3): sin RLS y sin acceso para yebo_app. */
  globalTablesWithTenantId?: string[];
  /** El esquema anterior tenía la política RLS sin NULLIF (fallo corregido por ADR-025). */
  previousHadRlsBug?: boolean;
  /** Extensiones que deben quedar instaladas. */
  extensions: string[];
  /** Migraciones del esquema anterior a ADR-024/025 (null: no existe un esquema anterior). */
  previous: string[] | null;
  /** Siembra datos de dos tenants con el rol exclusivo de pruebas (ADR-034); devuelve el número de filas por tabla. */
  seed?: (platform: Pool) => Promise<Record<string, number>>;
}

function prisma(set: MigrationSet, migrationsDir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [PRISMA_CLI, ...args, '--config', CONFIG], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      MIGRATION_TEST_SCHEMA: resolve(API_ROOT, set.schema),
      MIGRATION_TEST_MIGRATIONS: resolve(API_ROOT, migrationsDir),
    },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function expectOk(result: { status: number | null; output: string }): string {
  if (result.status !== 0) throw new Error(`Prisma terminó con ${result.status}:\n${result.output}`);
  return result.output;
}

/**
 * Deja la base como recién creada por el script de inicialización (ADR-034): esquema public vacío y sin extensiones.
 * Las bases de la aplicación NO tienen privilegios por defecto (cada migración declara sus GRANT); las de las PoC
 * de la Fase 2 sí dan DML por defecto a yebo_app, porque sus migraciones no llevan GRANT.
 */
async function resetDatabase(owner: Pool, set: MigrationSet): Promise<void> {
  await owner.query(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO yebo_app, yebo_platform, yebo_identity, yebo_test_bypass;`);
  if (set.schema.startsWith('test/poc/')) {
    await owner.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yebo_app;`);
  }
  const { rows } = await owner.query<{ objects: number; extensions: number }>(`
    SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public') AS objects,
           (SELECT count(*)::int FROM pg_extension WHERE extname <> 'plpgsql') AS extensions`);
  expect(rows[0]).toEqual({ objects: 0, extensions: 0 });
}

async function countAs(app: Pool, table: string, tenant: string | null): Promise<number> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    if (tenant !== null) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    await client.query('COMMIT');
    return rows[0]?.n ?? -1;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function rowCounts(platform: Pool, tables: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await platform.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
    counts[t] = rows[0]?.n ?? -1;
  }
  return counts;
}

/** Verificaciones comunes del estado final, idénticas para ambos caminos. */
async function verifyFinalState(set: MigrationSet, owner: Pool, app: Pool): Promise<void> {
  expect(expectOk(prisma(set, set.migrations, 'migrate', 'status'))).toMatch(/Database schema is up to date/);
  // ADR-024: la base REAL coincide con el esquema Prisma (no solo las migraciones).
  expectOk(
    prisma(
      set,
      set.migrations,
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      set.schema,
      '--exit-code',
    ),
  );

  const { rows: extensions } = await owner.query<{ extname: string }>(
    "SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1",
  );
  expect(extensions.map((e) => e.extname)).toEqual([...set.extensions].sort());

  const { rows: tables } = await owner.query<{ table: string; enabled: boolean; forced: boolean }>(`
    SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     ORDER BY 1`);
  const globals = set.globalTablesWithTenantId ?? [];
  const scoped = tables.filter((t) => !globals.includes(t.table));
  expect(scoped.map((t) => t.table)).toEqual([...set.tenantTables].sort());
  expect(scoped.filter((t) => !t.enabled || !t.forced)).toEqual([]);
  // Las excepciones globales existen, no tienen RLS de tenant y yebo_app no puede leerlas.
  expect(tables.filter((t) => globals.includes(t.table)).map((t) => t.table)).toEqual([...globals].sort());
  for (const g of globals) {
    const { rows } = await owner.query<{ can: boolean }>(
      `SELECT has_table_privilege('yebo_app', $1, 'SELECT') AS can`,
      [`public.${g}`],
    );
    expect(rows[0]?.can).toBe(false);
  }

  // ADR-025: toda política de tenant trata el contexto vacío como "sin tenant" (NULLIF), en USING y WITH CHECK.
  const { rows: policies } = await owner.query<{ table: string; qual: string; check: string }>(`
    SELECT tablename AS table, qual, with_check AS check FROM pg_policies
     WHERE schemaname = 'public' AND policyname = 'tenant_isolation' ORDER BY 1`);
  expect(policies.map((p) => p.table)).toEqual([...set.tenantTables].sort());
  for (const p of policies) {
    expect(p.qual).toMatch(/NULLIF\(current_setting\('app\.tenant_id'::text, true\), ''::text\)/);
    expect(p.check).toMatch(/NULLIF\(current_setting\('app\.tenant_id'::text, true\), ''::text\)/);
  }
  for (const t of set.tenantTables) {
    await expect(countAs(app, t, null)).resolves.toBe(0); // sin contexto
    await expect(countAs(app, t, '')).resolves.toBe(0); // contexto vacío explícito
  }
}

const SETS: MigrationSet[] = [
  {
    name: 'producción',
    schema: 'prisma/schema.prisma',
    migrations: 'prisma/migrations',
    tenantTables: ['tenant_memberships', 'roles', 'role_permissions', 'membership_roles'],
    // Del registro de modelos: una excepción global nueva no puede olvidarse aquí.
    globalTablesWithTenantId: [...GLOBAL_TABLES_WITH_TENANT_ID],
    extensions: ['btree_gist', 'citext'],
    // Esquema anterior = el de la etapa 3.1, con datos. Prueba que la migración de sesiones (3.2) se aplica
    // sobre membresías existentes (añade un índice único compuesto a tenant_memberships).
    previous: ['20261105000000_init_extensions', '20261105195054_fase3_1_tenancy_identity'],
    previousHadRlsBug: false,
    async seed(platform) {
      const user = randomUUID();
      for (const [tenant, n] of [
        [A, 1],
        [B, 2],
      ] as const) {
        await platform.query(
          `INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id_type, tax_id, updated_at)
           VALUES ($1, $2, $3, $3, 'RUC', $4, now())`,
          [tenant, `empresa-${n}`, `Empresa ${n}`, `2000000000${n}`],
        );
      }
      await platform.query(
        `INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES ($1, 'u@example.com', 'x', 'U', now())`,
        [user],
      );
      for (const tenant of [A, B]) {
        await platform.query(
          `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at) VALUES ($1, $2, $3, 'ACTIVE', now())`,
          [randomUUID(), tenant, user],
        );
      }
      return { tenants: 2, users: 1, tenant_memberships: 2 };
    },
  },
  {
    name: 'PoC aislamiento',
    schema: 'test/poc/tenancy/schema.prisma',
    migrations: 'test/poc/tenancy/migrations',
    tenantTables: ['poc_routes', 'poc_trips'],
    previousHadRlsBug: true,
    extensions: [],
    previous: ['20261105000100_poc_tenancy'],
    async seed(platform) {
      const routeA = randomUUID();
      const routeB = randomUUID();
      await platform.query("INSERT INTO poc_tenants (id, name) VALUES ($1, 'A'), ($2, 'B')", [A, B]);
      await platform.query(
        "INSERT INTO poc_routes (id, tenant_id, name) VALUES ($1, $2, 'Pucallpa - Iquitos'), ($3, $4, 'Yurimaguas - Iquitos')",
        [routeA, A, routeB, B],
      );
      await platform.query(
        `INSERT INTO poc_trips (id, tenant_id, route_id, code)
         VALUES (gen_random_uuid(), $1, $2, 'A-001'), (gen_random_uuid(), $1, $2, 'A-002'),
                (gen_random_uuid(), $3, $4, 'B-001')`,
        [A, routeA, B, routeB],
      );
      return { poc_tenants: 2, poc_routes: 2, poc_trips: 3 };
    },
  },
  {
    name: 'PoC inventario',
    schema: 'test/poc/inventory/schema.prisma',
    migrations: 'test/poc/inventory/migrations',
    tenantTables: [
      'inv_trips',
      'inv_trip_resources',
      'inv_resource_allocations',
      'inv_pools',
      'inv_pool_segment_usage',
      'inv_pool_allocations',
    ],
    previousHadRlsBug: true,
    extensions: ['btree_gist'],
    previous: ['20261105000200_poc_inventory'],
    async seed(platform) {
      for (const tenant of [A, B]) {
        const trip = randomUUID();
        const seat = randomUUID();
        const pool = randomUUID();
        await platform.query(
          'INSERT INTO inv_trips (id, tenant_id, code, stop_count) VALUES ($1, $2, $3, 4)',
          [trip, tenant, `T-${tenant.slice(-2)}`],
        );
        await platform.query(
          "INSERT INTO inv_trip_resources (id, tenant_id, trip_id, code, kind) VALUES ($1, $2, $3, '12A', 'SEAT')",
          [seat, tenant, trip],
        );
        await platform.query(
          `INSERT INTO inv_resource_allocations (id, tenant_id, trip_id, trip_resource_id, stop_range, status, holder_type, holder_id)
           VALUES (gen_random_uuid(), $1, $2, $3, int4range(0, 2), 'CONFIRMED', 'BOOKING_ITEM', gen_random_uuid())`,
          [tenant, trip, seat],
        );
        await platform.query(
          "INSERT INTO inv_pools (id, tenant_id, trip_id, code, dimension, capacity) VALUES ($1, $2, $3, 'ZONA', 'PERSONS', 10)",
          [pool, tenant, trip],
        );
        await platform.query(
          `INSERT INTO inv_pool_segment_usage (tenant_id, pool_id, segment_seq, capacity, used)
           SELECT $1, $2, s, 10, CASE WHEN s < 2 THEN 3 ELSE 0 END FROM generate_series(0, 2) s`,
          [tenant, pool],
        );
        await platform.query(
          `INSERT INTO inv_pool_allocations (id, tenant_id, pool_id, stop_range, quantity, status, holder_type, holder_id)
           VALUES (gen_random_uuid(), $1, $2, int4range(0, 2), 3, 'CONFIRMED', 'BOOKING_ITEM', gen_random_uuid())`,
          [tenant, pool],
        );
      }
      return {
        inv_trips: 2,
        inv_trip_resources: 2,
        inv_resource_allocations: 2,
        inv_pools: 2,
        inv_pool_segment_usage: 6,
        inv_pool_allocations: 2,
      };
    },
  },
];

describe.each(SETS)('migraciones · $name', (set) => {
  let owner: Pool;
  let app: Pool;
  let platform: Pool;

  beforeAll(() => {
    owner = testPool('owner', DB, 1);
    app = testPool('app', DB, 2);
    // Rol exclusivo de pruebas (ADR-034): siembra y cuenta filas de todos los tenants.
    platform = testBypassPool(DB, 1);
  });

  afterAll(async () => {
    await Promise.all([owner.end(), app.end(), platform.end()]);
  });

  it('desde una base vacía: aplica todas las migraciones y es idempotente', async () => {
    await resetDatabase(owner, set);
    expectOk(prisma(set, set.migrations, 'migrate', 'deploy'));
    await verifyFinalState(set, owner, app);
    // Una segunda ejecución no tiene nada pendiente.
    expect(expectOk(prisma(set, set.migrations, 'migrate', 'deploy'))).toMatch(/No pending migrations/);
  });

  const fromPrevious = set.previous ? it : it.skip;
  fromPrevious('desde el esquema anterior con datos: conserva los datos y aplica ADR-024/025', async () => {
    const previous = set.previous ?? [];
    const seed = set.seed;
    if (!seed) throw new Error('falta la siembra');
    await resetDatabase(owner, set);

    // 1) Esquema anterior: solo las migraciones previas a ADR-024/025.
    const tmp = mkdtempSync(join(tmpdir(), 'yebo-migrations-'));
    try {
      cpSync(resolve(API_ROOT, set.migrations, 'migration_lock.toml'), join(tmp, 'migration_lock.toml'));
      for (const m of previous)
        cpSync(resolve(API_ROOT, set.migrations, m), join(tmp, m), { recursive: true });
      expectOk(prisma(set, tmp, 'migrate', 'deploy'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // 2) Datos de dos tenants (el rol de pruebas recibe sus permisos tras migrar, como en global-setup).
    await grantTestBypass(DB);
    const expected = await seed(platform);
    if (set.previousHadRlsBug) {
      const firstTable = set.tenantTables[0] ?? '';
      // Comportamiento anterior (motivo de ADR-025): el contexto vacío lanzaba 22P02 en vez de dar 0 filas.
      await expect(countAs(app, firstTable, '')).rejects.toMatchObject({ code: '22P02' });
    }

    // 3) Migraciones nuevas sobre la base con datos.
    const output = expectOk(prisma(set, set.migrations, 'migrate', 'deploy'));
    expect(output).not.toMatch(/No pending migrations/);

    // 4) Datos intactos, aislamiento intacto y estado final idéntico al de una base nueva.
    await grantTestBypass(DB);
    await expect(rowCounts(platform, Object.keys(expected))).resolves.toEqual(expected);
    for (const t of set.tenantTables.filter((table) => table in expected)) {
      const total = expected[t] ?? 0;
      const forA = await countAs(app, t, A);
      const forB = await countAs(app, t, B);
      expect(forA).toBeGreaterThan(0);
      expect(forB).toBeGreaterThan(0);
      expect(forA + forB).toBe(total);
    }
    await verifyFinalState(set, owner, app);
  });
});
