/**
 * PRUEBA DE CONCEPTO 1 (Fase 2) — Aislamiento multitenant en la base de datos.
 * Valida ADR-003 y multitenancy §3, §4 y §7 contra PostgreSQL real con los roles reales:
 *  - Barrera de aplicación: extensión Prisma de producción (src/infrastructure/database/tenant-scope).
 *  - Barrera de base de datos: RLS forzado + set_config local a la transacción, rol yebo_app sin BYPASSRLS.
 *  - Integridad: FK compuestas (tenant_id, id) que impiden referencias entre tenants.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool, PoolClient } from 'pg';
import {
  MissingTenantContextError,
  TenantMismatchError,
  TenantTransactionMisuseError,
} from '../../../src/infrastructure/database/tenant-scope/tenant-scope.errors';
import {
  setTransactionTenant,
  tenantFilterExtension,
  tenantSessionExtension,
  withoutInteractiveTransactions,
  type TenantScopeOptions,
} from '../../../src/infrastructure/database/tenant-scope/tenant-scope.extension';
import { testDbUrl, testPool } from '../../support/db';
import { Prisma, PrismaClient } from './generated/client';

const DB = 'yebo_poc_tenancy';
const A = '0190f0a0-0000-7000-8000-00000000000a';
const B = '0190f0a0-0000-7000-8000-00000000000b';
const ROUTE_A = '0190f0a0-0000-7000-8000-0000000000a1';
const ROUTE_B = '0190f0a0-0000-7000-8000-0000000000b1';

const context = new AsyncLocalStorage<{ tenantId?: string }>();
const options: TenantScopeOptions = {
  tenantScopedModels: new Set(['PocRoute', 'PocTrip']),
  resolveTenantId: () => context.getStore()?.tenantId,
};
/**
 * Las PrismaPromise son PEREZOSAS: la consulta (y el hook de la extensión que lee el tenant) se ejecuta
 * al hacer `await`. Por eso el await debe ocurrir DENTRO del contexto (hallazgo documentado en la PoC).
 */
const asTenant = <T>(tenantId: string, fn: () => PromiseLike<T>): Promise<T> =>
  context.run({ tenantId }, async () => await fn());

function newClient(role: 'app' | 'platform', max: number): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: testDbUrl(role, DB), max }) });
}

/** Igual que TenantDbService en producción: filtro (barrera 1) + sesión RLS (barrera 2). */
function tenantDb(base: PrismaClient) {
  const filtered = base.$extends(tenantFilterExtension(options));
  const client = withoutInteractiveTransactions(filtered.$extends(tenantSessionExtension(options)));
  const transaction = <T>(
    fn: (tx: Parameters<Parameters<typeof filtered.$transaction>[0]>[0]) => Promise<T>,
  ) =>
    filtered.$transaction(async (tx) => {
      await setTransactionTenant(tx, options);
      return fn(tx);
    });
  return { client, transaction };
}

describe('PoC 1 · aislamiento multitenant (PostgreSQL real, rol yebo_app)', () => {
  let owner: Pool;
  let appBase: PrismaClient;
  let platform: PrismaClient;
  let db: ReturnType<typeof tenantDb>;

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    await owner.query('TRUNCATE poc_trips, poc_routes, poc_tenants');
    appBase = newClient('app', 4);
    platform = newClient('platform', 2);
    db = tenantDb(appBase);

    // Datos sembrados con el rol de plataforma (BYPASSRLS), como haría el superadmin.
    await platform.pocTenant.createMany({
      data: [
        { id: A, name: 'Transportes A' },
        { id: B, name: 'Naviera B' },
      ],
    });
    await platform.pocRoute.createMany({
      data: [
        { id: ROUTE_A, tenantId: A, name: 'Pucallpa - Iquitos' },
        { id: ROUTE_B, tenantId: B, name: 'Yurimaguas - Iquitos' },
      ],
    });
    await platform.pocTrip.createMany({
      data: [
        { tenantId: A, routeId: ROUTE_A, code: 'A-001' },
        { tenantId: B, routeId: ROUTE_B, code: 'B-001' },
      ],
    });
  });

  afterAll(async () => {
    await Promise.all([appBase.$disconnect(), platform.$disconnect(), owner.end()]);
  });

  describe('barrera de aplicación + RLS (cliente de tenant)', () => {
    it('cada tenant ve únicamente sus filas', async () => {
      const routesA = await asTenant(A, () => db.client.pocRoute.findMany());
      const routesB = await asTenant(B, () => db.client.pocRoute.findMany());
      expect(routesA.map((r) => r.id)).toEqual([ROUTE_A]);
      expect(routesB.map((r) => r.id)).toEqual([ROUTE_B]);
    });

    it('buscar por id una fila de otro tenant devuelve null (IDOR → 404, no 403)', async () => {
      await expect(
        asTenant(A, () => db.client.pocRoute.findUnique({ where: { id: ROUTE_B } })),
      ).resolves.toBeNull();
    });

    it('no puede modificar ni borrar filas de otro tenant', async () => {
      const updated = await asTenant(A, () =>
        db.client.pocRoute.updateMany({ where: { id: ROUTE_B }, data: { name: 'secuestrada' } }),
      );
      expect(updated.count).toBe(0);
      await expect(
        asTenant(A, () =>
          db.client.pocRoute.update({ where: { id: ROUTE_B }, data: { name: 'secuestrada' } }),
        ),
      ).rejects.toMatchObject({ code: 'P2025' });
      const deleted = await asTenant(A, () => db.client.pocTrip.deleteMany({ where: { code: 'B-001' } }));
      expect(deleted.count).toBe(0);
      const routeB = await platform.pocRoute.findUniqueOrThrow({ where: { id: ROUTE_B } });
      expect(routeB.name).toBe('Yurimaguas - Iquitos');
    });

    it('rechaza escribir con un tenantId distinto al del contexto', async () => {
      await expect(
        asTenant(A, () => db.client.pocRoute.create({ data: { tenantId: B, name: 'intrusa' } })),
      ).rejects.toBeInstanceOf(TenantMismatchError);
    });

    it('convención: el servicio pasa el tenantId del contexto y la extensión lo verifica', async () => {
      const route = await asTenant(A, () =>
        db.client.pocRoute.create({ data: { tenantId: A, name: 'Contamana - Iquitos' } }),
      );
      expect(route.tenantId).toBe(A);
      await platform.pocRoute.delete({ where: { id: route.id } });
    });

    it('defensa: si el código omitiera tenantId (sorteando los tipos), la extensión fija el del contexto', async () => {
      // Los tipos de Prisma exigen tenantId; la conversión solo simula un error de programación.
      const unsafe = { name: 'Contamana - Iquitos' } as unknown as Prisma.PocRouteUncheckedCreateInput;
      const route = await asTenant(A, () => db.client.pocRoute.create({ data: unsafe }));
      expect(route.tenantId).toBe(A);
      await platform.pocRoute.delete({ where: { id: route.id } });
    });

    it('sin contexto de tenant la operación falla (nunca devuelve todo)', async () => {
      await expect(db.client.pocRoute.findMany()).rejects.toBeInstanceOf(MissingTenantContextError);
    });

    it('los modelos globales no requieren contexto', async () => {
      await expect(db.client.pocTenant.count()).resolves.toBe(2);
    });
  });

  describe('barrera de base de datos (RLS) por sí sola', () => {
    it('sin set_config, yebo_app no ve ninguna fila de tenant', async () => {
      const rows = await appBase.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM poc_routes`;
      expect(rows[0]?.n).toBe(0);
    });

    it('aunque la barrera de aplicación faltara, RLS impide leer otro tenant', async () => {
      // Simula un error de programación: cliente SIN filtro de aplicación, solo con la sesión RLS.
      const sessionOnly = appBase.$extends(tenantSessionExtension(options));
      const leaked = await asTenant(A, () => sessionOnly.pocRoute.findMany({ where: { tenantId: B } }));
      expect(leaked).toEqual([]);
    });

    it('RLS (WITH CHECK) rechaza insertar filas de otro tenant aun con SQL directo', async () => {
      await expect(
        appBase.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${A}, true)`;
          await tx.$executeRaw`INSERT INTO poc_routes (id, tenant_id, name) VALUES (gen_random_uuid(), ${B}::uuid, 'x')`;
        }),
      ).rejects.toThrow(/row-level security/);
    });

    it('yebo_app no puede crear tenants (tabla global de solo lectura)', async () => {
      await expect(
        appBase.$executeRaw`INSERT INTO poc_tenants (id, name) VALUES (gen_random_uuid(), 'x')`,
      ).rejects.toThrow(/permission denied/);
    });

    it('toda tabla con tenant_id tiene RLS habilitado y forzado (verificación automática)', async () => {
      const { rows } = await owner.query<{ table: string; enabled: boolean; forced: boolean }>(`
        SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         WHERE c.relkind = 'r'
           AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r) => !r.enabled || !r.forced)).toEqual([]);
    });
  });

  describe('integridad referencial entre tenants', () => {
    it('la FK compuesta impide un viaje del tenant A sobre una ruta del tenant B, incluso sin RLS', async () => {
      await expect(
        platform.pocTrip.create({ data: { tenantId: A, routeId: ROUTE_B, code: 'A-CRUZADO' } }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('la FK compuesta no permite cambiar el tenant de una ruta con viajes (ON UPDATE RESTRICT)', async () => {
      await expect(
        platform.pocRoute.update({ where: { id: ROUTE_A }, data: { tenantId: B } }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });
  });

  describe('pool de conexiones compartido', () => {
    it('120 operaciones concurrentes de dos tenants sobre 2 conexiones no mezclan contexto', async () => {
      const smallBase = newClient('app', 2);
      const small = tenantDb(smallBase);
      try {
        const results = await Promise.all(
          Array.from({ length: 120 }, (_, i) => {
            const tenantId = i % 2 === 0 ? A : B;
            return asTenant(tenantId, async () => {
              const routes = await small.client.pocRoute.findMany();
              return routes.every((r) => r.tenantId === tenantId) && routes.length === 1;
            });
          }),
        );
        expect(results.every(Boolean)).toBe(true);

        // set_config(..., true) es local a la transacción: la conexión reutilizada queda sin tenant.
        const leftover = await smallBase.$queryRaw<{ tenant: string | null; n: number }[]>`
          SELECT current_setting('app.tenant_id', true) AS tenant, (SELECT count(*)::int FROM poc_routes) AS n`;
        expect(leftover[0]?.n).toBe(0);
        expect(leftover[0]?.tenant ?? '').toBe('');
      } finally {
        await smallBase.$disconnect();
      }
    });
  });

  describe('ADR-025 · contexto por transacción, nunca heredado (una sola conexión reutilizada)', () => {
    let single: Pool;
    const count = async (client: PoolClient) =>
      (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM poc_routes')).rows[0]?.n;
    const tenantsSeen = async (client: PoolClient) =>
      (await client.query<{ t: string }>('SELECT DISTINCT tenant_id::text AS t FROM poc_routes')).rows.map(
        (r) => r.t,
      );
    const setting = async (client: PoolClient) =>
      (await client.query<{ v: string | null }>("SELECT current_setting('app.tenant_id', true) AS v")).rows[0]
        ?.v ?? '';

    beforeAll(() => {
      single = testPool('app', DB, 1); // toda operación usa LA MISMA conexión física
    });
    afterAll(async () => {
      await single.end();
    });

    async function withConnection(fn: (client: PoolClient, pid: number) => Promise<void>): Promise<number> {
      const client = await single.connect();
      try {
        const pid =
          (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? -1;
        await fn(client, pid);
        return pid;
      } finally {
        client.release();
      }
    }

    it('contexto vacío explícito ("") → 0 filas, sin error de conversión', async () => {
      await withConnection(async (c) => {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', '', true)");
        expect(await count(c)).toBe(0);
        await c.query('COMMIT');
      });
    });

    it('conexión nueva sin contexto → 0 filas', async () => {
      await withConnection(async (c) => {
        expect(await setting(c)).toBe('');
        expect(await count(c)).toBe(0);
      });
    });

    it('tras COMMIT, la conexión reutilizada no conserva el tenant y otra transacción fija el suyo', async () => {
      const pid1 = await withConnection(async (c) => {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
        expect(await tenantsSeen(c)).toEqual([A]);
        await c.query('COMMIT');
      });
      const pid2 = await withConnection(async (c) => {
        expect(await setting(c)).toBe(''); // nada heredado
        expect(await count(c)).toBe(0);
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [B]);
        expect(await tenantsSeen(c)).toEqual([B]);
        await c.query('COMMIT');
      });
      expect(pid2).toBe(pid1); // misma conexión física
    });

    it('tras ROLLBACK, la conexión reutilizada tampoco conserva el tenant', async () => {
      await withConnection(async (c) => {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
        await c.query('ROLLBACK');
      });
      await withConnection(async (c) => {
        expect(await setting(c)).toBe('');
        expect(await count(c)).toBe(0);
      });
    });

    it('tras un error dentro de la transacción, la conexión reutilizada queda sin tenant', async () => {
      await withConnection(async (c) => {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
        await expect(c.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
        await c.query('ROLLBACK');
      });
      await withConnection(async (c) => {
        expect(await setting(c)).toBe('');
        expect(await count(c)).toBe(0);
      });
    });

    it('la extensión Prisma con 1 conexión: tenants alternos nunca ven datos del anterior', async () => {
      const oneBase = newClient('app', 1);
      const one = tenantDb(oneBase);
      try {
        for (let i = 0; i < 20; i++) {
          const tenantId = i % 2 === 0 ? A : B;
          const routes = await asTenant(tenantId, () => one.client.pocRoute.findMany());
          expect(routes.map((r) => r.tenantId)).toEqual([tenantId]);
          const viaTx = await asTenant(tenantId, () =>
            one.transaction(
              async (tx) => tx.$queryRaw<{ t: string }[]>`SELECT tenant_id::text AS t FROM poc_routes`,
            ),
          );
          expect(viaTx.map((r) => r.t)).toEqual([tenantId]);
          // Entre operaciones, la conexión queda sin tenant.
          const between = await oneBase.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM poc_routes`;
          expect(between[0]?.n).toBe(0);
        }
      } finally {
        await oneBase.$disconnect();
      }
    });
  });

  describe('transacciones interactivas', () => {
    it('fijan el tenant al inicio: lecturas, escrituras y SQL crudo quedan aislados', async () => {
      const outcome = await asTenant(B, () =>
        db.transaction(async (tx) => {
          const created = await tx.pocRoute.create({ data: { tenantId: B, name: 'Iquitos - Santa Rosa' } });
          const visible = await tx.pocRoute.findMany();
          const raw = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM poc_routes`;
          return { created, visible, rawCount: raw[0]?.n };
        }),
      );
      expect(outcome.created.tenantId).toBe(B);
      expect(outcome.visible.every((r) => r.tenantId === B)).toBe(true);
      expect(outcome.rawCount).toBe(outcome.visible.length);
      await platform.pocRoute.delete({ where: { id: outcome.created.id } });
    });

    it('el cliente por operación no permite $transaction (se usa db.transaction)', async () => {
      const unsafe = db.client as unknown as { $transaction: (fn: () => Promise<void>) => Promise<void> };
      await expect(
        asTenant(A, async () => unsafe.$transaction(async () => undefined)),
      ).rejects.toBeInstanceOf(TenantTransactionMisuseError);
      // El resto del cliente sigue funcionando a través del proxy.
      await expect(asTenant(A, () => db.client.pocRoute.count())).resolves.toBe(1);
    });

    it('sin contexto, la transacción no se abre', async () => {
      await expect(db.transaction(async (tx) => tx.pocRoute.findMany())).rejects.toBeInstanceOf(
        MissingTenantContextError,
      );
    });
  });

  it('el rol de plataforma (BYPASSRLS) ve todos los tenants', async () => {
    await expect(platform.pocRoute.count()).resolves.toBe(2);
  });
});
