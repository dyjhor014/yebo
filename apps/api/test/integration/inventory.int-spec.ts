/**
 * Fase 7.4 · Motor de inventario por tramo y bloqueos operativos (capacity-and-inventory §3–6; ADR-007 y ADR-026;
 * F7-Q5). PostgreSQL y Redis reales, con las tablas de producción, `yebo_app` y RLS:
 * - la suite obligatoria §6 (1 a 8) contra el motor, con concurrencia real y la reconciliación tras cada prueba;
 * - bloqueos operativos por la API (crear, ver, liberar, disponibilidad tramo por tramo, errores con el tramo);
 * - lo que cambia en los viajes (volver a planificar o cancelar con ocupación, plano con historia);
 * - reglas de la base, aislamiento, permisos y estados del tenant.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { boatTemplate, cabin, type LayoutDocument } from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { PERMISSION_CODES } from '../../src/modules/access/permission-catalog';
import { AppError } from '../../src/common/errors/app-error';
import { SessionService } from '../../src/modules/identity/session.service';
import { InventoryService, type AllocationRequest } from '../../src/modules/inventory/inventory.service';
import { RESET_TENANT_DATA, testBypassPool, testPool } from '../support/db';
import { STAFF_CSRF, seedPlatformSession } from '../support/platform-session';

const DB = 'yebo_test';
const ADMIN = 'admin.yebo.pe';
const HUB = 'cuentas.yebo.pe';
const CSRF = 'csrf-de-prueba-0123456789abcdef';
const PASSWORD = 'rios-claros-del-amazonas-2026';

type Company = { id: string; host: string; adminUserId: string };
type Method = 'get' | 'put' | 'post';

const PLACES = {
  pucallpa: { name: 'Pucallpa', kind: 'PORT', lat: -8.3791, lng: -74.5539 },
  contamana: { name: 'Contamana', kind: 'PORT', lat: -7.3352, lng: -75.0094 },
  yurimaguas: { name: 'Yurimaguas', kind: 'LANDING', lat: -5.8984, lng: -76.0911 },
  iquitos: { name: 'Iquitos', kind: 'CITY', lat: -3.7491, lng: -73.2472 },
  requena: { name: 'Requena', kind: 'LANDING', lat: null, lng: null },
} as const;
type Place = keyof typeof PLACES;

describe('Fase 7.4 · inventario por tramo', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let staff = '';
  let a: Company;
  let b: Company;
  const loc: Record<Place, string> = {
    pucallpa: '',
    contamana: '',
    yurimaguas: '',
    iquitos: '',
    requena: '',
  };

  const http = () => request(app.getHttpServer());
  const asStaff = (method: 'get' | 'post', path: string, body?: object) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', staff);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  const cookie = async (c: Company, userId = c.adminUserId) => {
    const sessions = app.get(SessionService);
    const identity = (await sessions.createIdentitySession({ userId, authMethods: ['pwd'] })).id;
    const token = (await sessions.openTenantSession({ identitySessionId: identity, host: c.host }))
      .accessToken;
    return `__Host-yebo_at=${token}; __Host-yebo_csrf=${CSRF}`;
  };
  const as = async (c: Company, method: Method, path: string, body?: object, userId = c.adminUserId) => {
    const agent = http();
    let req = agent[method](path)
      .set('Host', c.host)
      .set('Cookie', await cookie(c, userId));
    if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
    return body ? req.send(body) : req;
  };
  const company = async (slug: string, planVersionId: string): Promise<Company> => {
    const created = await asStaff('post', '/api/v1/platform/tenants', {
      slug,
      legalName: `${slug} SAC`,
      tradeName: `Empresa ${slug}`,
      taxIdType: 'RUC',
      taxId: `20${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      planVersionId,
      services: [
        { modality: 'RIVER', service: 'PASSENGER' },
        { modality: 'RIVER', service: 'CARGO' },
        { modality: 'RIVER', service: 'PARCEL' },
        { modality: 'LAND', service: 'PASSENGER' },
      ],
      firstAdminEmail: `admin@${slug}.pe`,
    });
    expect(created.status).toBe(201);
    const link = created.body.firstAdminInvitation.link as string;
    const reg = await http()
      .post('/api/v1/hub/invitations/register')
      .set('Host', HUB)
      .set('Cookie', `__Host-yebo_csrf=${CSRF}`)
      .set('X-CSRF-Token', CSRF)
      .send({ token: link.split('#')[1], fullName: 'Gerencia General', password: PASSWORD });
    expect(reg.status).toBe(200);
    const userId = (
      await seed.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`admin@${slug}.pe`])
    ).rows[0]?.id as string;
    return { id: created.body.id, host: created.body.primaryHost, adminUserId: userId };
  };

  const stop = (place: Place, offsetMinutes: number, over: object = {}) => ({
    locationId: loc[place],
    offsetMinutes,
    dwellMinutes: 0,
    allowsBoarding: true,
    allowsAlighting: true,
    pathToNext: null,
    ...over,
  });
  /** Pucallpa → Contamana (con traza) → Yurimaguas → Iquitos: 3 días y medio río abajo y río arriba. */
  const amazonas = () => [
    stop('pucallpa', 0, { allowsAlighting: false }),
    stop('contamana', 720, { dwellMinutes: 60 }),
    stop('yurimaguas', 2160, { dwellMinutes: 120 }),
    stop('iquitos', 5040, { allowsBoarding: false }),
  ];

  /** Transacción de yebo_app en el tenant, siempre revertida (o confirmada para ver el trigger diferido). */
  const inTenant = async <T>(
    c: Company,
    fn: (client: PoolClient) => Promise<T>,
    commit = false,
  ): Promise<T> => {
    const pool = testPool('app', DB, 1);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [c.id]);
      const result = await fn(client);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
      await pool.end();
    }
  };

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    seed = testBypassPool(DB, 2);
    await owner.query(
      `TRUNCATE plan_version_modules, plan_versions, plans, platform_audit_logs, platform_setup_tokens,
                platform_sessions, platform_users CASCADE`,
    );
    await owner.query(RESET_TENANT_DATA);
    await owner.query(
      `INSERT INTO permissions (id, code, module_code, description, is_sensitive, updated_at)
         SELECT gen_random_uuid(), c, 'ACCESS', c, false, now() FROM unnest($1::text[]) c
       ON CONFLICT (code) DO NOTHING`,
      [PERMISSION_CODES],
    );
    await owner.query(
      `INSERT INTO role_templates (id, code, name, permission_codes, updated_at)
         VALUES (gen_random_uuid(), 'ADMIN', 'Administrador', $1, now())
       ON CONFLICT (code) DO UPDATE SET permission_codes = EXCLUDED.permission_codes`,
      [PERMISSION_CODES],
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(nest, parseEnv(process.env), { swagger: false });
    await nest.init();
    app = nest;
    const redis = app.get(RedisService);
    const keys = await redis.client.keys('rl:*');
    if (keys.length > 0) await redis.client.del(...keys);
    staff = (
      await seedPlatformSession(seed, { email: 'inventario@yebo.pe', role: 'SUPERADMIN', now: new Date() })
    ).cookie;
    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'inventario', name: 'Inventario' });
    const v = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
      basePrice: '99.00',
      billingInterval: 'MONTHLY',
      includedUsers: 5,
      extraUserPrice: '15.00',
      trialDays: 0,
      modules: ['PASSENGERS'],
    });
    await asStaff('post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
    a = await company('inv-a', v.body.id);
    b = await company('inv-b', v.body.id);
    for (const [key, place] of Object.entries(PLACES) as [Place, (typeof PLACES)[Place]][]) {
      const created = await as(a, 'post', '/api/v1/locations', { ...place, ubigeo: null, region: null });
      expect(created.status).toBe(201);
      loc[key] = created.body.id;
    }
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  /** Fecha `AAAA-MM-DD` a `offset` días de hoy en Lima (el calendario de la empresa). */
  const day = (offset: number) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  const at = (offset: number, time: string) => `${day(offset)}T${time}`;

  let routeId = '';
  const ids = { lancha: '', layout: '' };
  let engine: InventoryService;
  let cls: ClsService;

  /** Plano de la suite: la lancha con un camarote C1 de 4 camas y la zona libre de 10 personas (capacity-and-inventory §6). */
  const suiteLayout = (): LayoutDocument => {
    const doc = boatTemplate();
    doc.elements = doc.elements.filter(
      (e) => !['C1', 'C2'].includes(e.code) && !['C1', 'C2'].includes(e.parentCode ?? ''),
    );
    doc.elements.push(...cabin({ cellCm: 50, code: 'C1', zoneCode: 'CAMAROTES', x: 0, y: 2, beds: 4 }));
    const libre = doc.zones.find((z) => z.code === 'LIBRE');
    if (libre) libre.capacity = [{ dimension: 'PERSONS', value: 10 }];
    return doc;
  };

  type OpenTrip = { id: string; pools: Record<string, string> };
  let tripCount = 0;
  /** Un viaje nuevo de la lancha (cada 4 días: dura 3 días y medio), abierto a la venta, con sus pools por clave. */
  const openTrip = async (): Promise<OpenTrip> => {
    tripCount += 1;
    const created = await as(a, 'post', '/api/v1/trips', {
      routeId,
      departureLocal: at(4 * tripCount, '08:00'),
      vehicleId: ids.lancha,
      layout: null,
      minPassengers: null,
      confirmationDeadlineLocal: null,
    });
    expect(created.status).toBe(201);
    expect((await as(a, 'post', `/api/v1/trips/${created.body.id}/open`)).status).toBe(200);
    const pools: Record<string, string> = {};
    for (const p of created.body.inventory.pools as {
      id: string;
      zoneCode: string | null;
      dimension: string;
    }[]) {
      pools[`${p.zoneCode ?? 'UNIDAD'}:${p.dimension}`] = p.id;
    }
    return { id: created.body.id, pools };
  };

  /** Ejecuta en el contexto de la empresa A, como una petición (cada llamada concurrente con su propio contexto). */
  const inA = <T>(fn: () => Promise<T>): Promise<T> =>
    cls.run(async () => {
      cls.set('tenantId', a.id);
      cls.set('tenant', {
        id: a.id,
        slug: 'inv-a',
        tradeName: 'A',
        status: 'ACTIVE',
        cancelledAt: null,
        timezone: 'America/Lima',
      });
      return fn();
    });
  const holder = (): string => crypto.randomUUID();
  const sell = (trip: OpenTrip, over: Partial<AllocationRequest>) =>
    inA(() =>
      engine.allocate({
        tripId: trip.id,
        fromSeq: 0,
        toSeq: 3,
        holderType: 'BLOCK',
        holderId: holder(),
        ...over,
      }),
    );
  /** Resultado de una asignación: 'ok' o el código del error de dominio (cualquier otro error se propaga). */
  const outcome = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      if (e instanceof AppError) return e.code;
      throw e;
    }
  };
  const count = (xs: string[], x: string) => xs.filter((y) => y === x).length;
  const availability = async (trip: OpenTrip) =>
    (await as(a, 'get', `/api/v1/trips/${trip.id}/availability`)).body;

  afterEach(async () => {
    // §6.8 · invariante de reconciliación tras cada prueba: used = Σ asignaciones activas, en cada pool y tramo.
    if (engine) expect(await inA(() => engine.reconciliation())).toEqual([]);
  });

  const layout = async (name: string, modality: string, document: object, publish = true) => {
    const created = await as(a, 'post', '/api/v1/layouts', { name, modality, vehicleTypeId: null, document });
    expect(created.status).toBe(201);
    if (publish)
      expect((await as(a, 'post', `/api/v1/layouts/${created.body.layoutId}/publish`)).status).toBe(200);
    return created.body.layoutId as string;
  };
  const vehicleBody = (code: string, typeId: string, status = 'ACTIVE') => ({
    code,
    name: code,
    vehicleTypeId: typeId,
    registration: `${code}-2026`,
    status,
    ownership: 'OWN',
    nominalCapacity: { passengers: null, weightKg: null, volumeM3: null },
    features: [],
  });
  const types: Record<string, string> = {};
  const vehicle = async (code: string, modality: 'RIVER' | 'LAND', layoutId: string | null) => {
    types[modality] ??= (
      await as(a, 'post', '/api/v1/vehicle-types', { name: `Tipo ${modality}`, modality, catalogCode: null })
    ).body.id;
    const created = await as(a, 'post', '/api/v1/vehicles', vehicleBody(code, types[modality] as string));
    expect(created.status).toBe(201);
    if (layoutId) {
      const assigned = await as(a, 'post', `/api/v1/vehicles/${created.body.id}/layout-assignments`, {
        layoutId,
        version: 1,
        validFrom: day(0),
        validTo: null,
      });
      expect(assigned.status).toBe(201);
    }
    return created.body.id as string;
  };
  it('preparación: ruta de 4 paradas (3 tramos), la lancha de la suite y su plano', async () => {
    engine = app.get(InventoryService);
    cls = app.get(ClsService);
    const route = await as(a, 'post', '/api/v1/routes', {
      code: 'PCL-IQT',
      name: 'Pucallpa – Iquitos',
      modality: 'RIVER',
      stops: amazonas(),
    });
    routeId = route.body.id;
    ids.layout = await layout('Lancha suite', 'RIVER', suiteLayout());
    ids.lancha = await vehicle('LANCHA-01', 'RIVER', ids.layout);
    const trip = await openTrip();
    const inv = (await as(a, 'get', `/api/v1/trips/${trip.id}/inventory`)).body;
    expect(inv.resources.filter((r: { parentCode: string | null }) => r.parentCode === 'C1')).toHaveLength(4);
    expect(inv.pools.find((p: { zoneCode: string | null }) => p.zoneCode === 'LIBRE').capacity).toBe(10);
  });

  describe('suite §6 (capacity-and-inventory)', () => {
    it('§6.1 · 50 asignaciones simultáneas del mismo asiento en [0,2): exactamente 1 éxito y ningún interbloqueo (5 asientos)', async () => {
      const trip = await openTrip();
      for (const seat of ['1A', '1B', '1C', '1D', '1E']) {
        const results = await Promise.all(
          Array.from({ length: 50 }, () =>
            outcome(sell(trip, { resourceCodes: [seat], fromSeq: 0, toSeq: 2 })),
          ),
        );
        expect([count(results, 'ok'), count(results, 'RESOURCE_UNAVAILABLE')]).toEqual([1, 49]);
      }
    });

    it('ADR-026 · 40 rondas de 2 asignaciones simultáneas del mismo asiento y tramo: 1 éxito y 1 ocupado por ronda, sin 40P01', async () => {
      const trip = await openTrip();
      const seats = [3, 4, 5, 6].flatMap((row) =>
        ['A', 'B', 'C', 'D', 'E', 'F'].map((col) => `${row}${col}`),
      );
      const rounds = seats.flatMap((seat) => [0, 1].map((from) => ({ seat, from }))).slice(0, 40);
      for (const { seat, from } of rounds) {
        const results = await Promise.all(
          [0, 1].map(() => outcome(sell(trip, { resourceCodes: [seat], fromSeq: from, toSeq: from + 1 }))),
        );
        expect(results.sort()).toEqual(['RESOURCE_UNAVAILABLE', 'ok']);
      }
    });

    it('§6.2 · [0,1) y [1,3) del mismo asiento a la vez: los dos (se tocan en Contamana, no se solapan)', async () => {
      const trip = await openTrip();
      const results = await Promise.all([
        outcome(sell(trip, { resourceCodes: ['1A'], fromSeq: 0, toSeq: 1 })),
        outcome(sell(trip, { resourceCodes: ['1A'], fromSeq: 1, toSeq: 3 })),
      ]);
      expect(results).toEqual(['ok', 'ok']);
    });

    it('§6.3 · [0,2) y [1,3) del mismo asiento a la vez: 1 éxito (20 rondas, un asiento por ronda)', async () => {
      const trip = await openTrip();
      const seats = [1, 2, 3, 4].flatMap((row) => ['A', 'B', 'C', 'D', 'E'].map((col) => `${row}${col}`));
      for (const seat of seats) {
        const results = await Promise.all([
          outcome(sell(trip, { resourceCodes: [seat], fromSeq: 0, toSeq: 2 })),
          outcome(sell(trip, { resourceCodes: [seat], fromSeq: 1, toSeq: 3 })),
        ]);
        expect([count(results, 'ok'), count(results, 'RESOURCE_UNAVAILABLE')]).toEqual([1, 1]);
      }
    });

    it('§6.4 · camarote completo frente a sus 4 camas sueltas a la vez: o el camarote o las camas, nunca una mezcla (10 rondas)', async () => {
      const trip = await openTrip();
      for (let round = 0; round < 10; round++) {
        const cabinHolder = holder();
        const bedHolders = [1, 2, 3, 4].map(() => holder());
        const [whole, ...beds] = await Promise.all([
          outcome(sell(trip, { resourceCodes: ['C1'], holderId: cabinHolder })),
          ...bedHolders.map((h, i) => outcome(sell(trip, { resourceCodes: [`C1-B${i + 1}`], holderId: h }))),
        ]);
        const active = await inTenant(a, (c) =>
          c.query<{ holder: string; n: number }>(
            `SELECT a.holder_id::text AS holder, count(*)::int AS n FROM resource_allocations a
               JOIN trip_resources r ON r.id = a.trip_resource_id
              WHERE a.trip_id = $1 AND r.parent_trip_resource_id IS NOT NULL AND a.status <> 'RELEASED'
              GROUP BY a.holder_id`,
            [trip.id],
          ),
        );
        if (whole === 'ok') {
          expect(beds).toEqual([
            'RESOURCE_UNAVAILABLE',
            'RESOURCE_UNAVAILABLE',
            'RESOURCE_UNAVAILABLE',
            'RESOURCE_UNAVAILABLE',
          ]);
          expect(active.rows).toEqual([{ holder: cabinHolder, n: 4 }]);
        } else {
          expect(whole).toBe('RESOURCE_UNAVAILABLE');
          // Las camas no compiten entre sí: si el camarote no ganó, alguna cama ganó y cada cama tiene a lo más un titular.
          expect(active.rows.every((r) => r.n === 1 && bedHolders.includes(r.holder))).toBe(true);
          expect(active.rows.length).toBe(count(beds, 'ok'));
        }
        await inA(() => engine.release([cabinHolder, ...bedHolders]));
      }
      // Dos camas distintas a la vez: ambas.
      const two = await Promise.all([
        outcome(sell(trip, { resourceCodes: ['C1-B1'] })),
        outcome(sell(trip, { resourceCodes: ['C1-B2'] })),
      ]);
      expect(two).toEqual(['ok', 'ok']);
      // Y con una cama vendida, el camarote completo no se vende (no hay camarotes «incompletos»).
      expect(await outcome(sell(trip, { resourceCodes: ['C1'] }))).toBe('RESOURCE_UNAVAILABLE');
    });

    it('§6.5 · zona libre de 10 y 25 asignaciones simultáneas con tramos al azar: ningún tramo supera 10 y used = Σ', async () => {
      const trip = await openTrip();
      const pool = trip.pools['LIBRE:PERSONS'] as string;
      const ranges = Array.from({ length: 25 }, () => {
        const from = Math.floor(Math.random() * 3);
        return [from, from + 1 + Math.floor(Math.random() * (3 - from))] as const;
      });
      const results = await Promise.all(
        ranges.map(([fromSeq, toSeq]) =>
          outcome(sell(trip, { pools: [{ poolId: pool, quantity: 1 }], fromSeq, toSeq })),
        ),
      );
      expect(results.every((r) => r === 'ok' || r === 'CAPACITY_EXCEEDED')).toBe(true);
      const expected = [0, 1, 2].map(
        (seg) => ranges.filter(([f, t], i) => results[i] === 'ok' && f <= seg && seg < t).length,
      );
      const libre = (await availability(trip)).pools.find((p: { id: string }) => p.id === pool);
      expect(libre.used).toEqual(expected);
      expect(Math.max(...libre.used)).toBeLessThanOrEqual(10);
      expect(Math.max(...libre.used)).toBe(10); // 25 pedidos sobre 3 tramos llenan alguno
    });

    it('§6.6 · 30 asignaciones peso + volumen en la bodega, la mitad en orden inverso: sin interbloqueos', async () => {
      const trip = await openTrip();
      const weight = trip.pools['BODEGA:WEIGHT_KG'] as string;
      const volume = trip.pools['BODEGA:VOLUME_M3'] as string;
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) => {
          const demands = [
            { poolId: weight, quantity: 300 },
            { poolId: volume, quantity: 2.1 },
          ];
          return outcome(
            sell(trip, { pools: i % 2 ? demands.reverse() : demands, fromSeq: i % 3, toSeq: 3 }),
          );
        }),
      );
      // Bodega de 8000 kg y 40 m³: el peso se agota (8000 / 300 = 26) antes que el volumen (40 / 2,1 = 19).
      expect(results.every((r) => r === 'ok' || r === 'CAPACITY_EXCEEDED')).toBe(true);
      const avail = (await availability(trip)).pools;
      const vol = avail.find((p: { id: string }) => p.id === volume);
      expect(Math.max(...vol.used)).toBeLessThanOrEqual(40);
      expect(count(results, 'ok')).toBeGreaterThan(0);
    });

    it('§6.7 · una retención vencida se libera entera (asiento y su cupo) y se revende; una vigente sí bloquea', async () => {
      const trip = await openTrip();
      const libre = trip.pools['LIBRE:PERSONS'] as string;
      const first = holder();
      await sell(trip, {
        resourceCodes: ['1A'],
        pools: [{ poolId: libre, quantity: 1 }],
        holderId: first,
        holdExpiresAt: new Date(Date.now() + 1500),
      });
      expect(await outcome(sell(trip, { resourceCodes: ['1A'] }))).toBe('RESOURCE_UNAVAILABLE');
      await new Promise((r) => setTimeout(r, 1700));
      // La disponibilidad ya no cuenta la retención vencida, aunque siga sin liberar.
      expect(
        (await availability(trip)).resources.find((r: { code: string }) => r.code === '1A').free,
      ).toEqual([true, true, true]);
      expect(
        await outcome(sell(trip, { resourceCodes: ['1A'], pools: [{ poolId: libre, quantity: 1 }] })),
      ).toBe('ok');
      const rows = await inTenant(a, (c) =>
        c.query<{ table: string; status: string }>(
          `SELECT 'resource' AS table, status::text FROM resource_allocations WHERE holder_id = $1
           UNION ALL SELECT 'pool', status::text FROM pool_allocations WHERE holder_id = $1`,
          [first],
        ),
      );
      expect(rows.rows).toEqual([
        { table: 'resource', status: 'RELEASED' },
        { table: 'pool', status: 'RELEASED' },
      ]);
      expect((await availability(trip)).pools.find((p: { id: string }) => p.id === libre).used).toEqual([
        1, 1, 1,
      ]);
    });

    it('ejemplo H · aforo de la unidad lleno: aunque el asiento esté libre, no se asigna nada (atómico)', async () => {
      const trip = await openTrip();
      const aforo = trip.pools['UNIDAD:PERSONS'] as string;
      await sell(trip, { pools: [{ poolId: aforo, quantity: 110 }] });
      const res = await outcome(
        sell(trip, { resourceCodes: ['2A'], pools: [{ poolId: aforo, quantity: 1 }] }),
      );
      expect(res).toBe('CAPACITY_EXCEEDED');
      expect(
        (await availability(trip)).resources.find((r: { code: string }) => r.code === '2A').free,
      ).toEqual([true, true, true]);
    });

    it('liberar devuelve exactamente el recurso y la capacidad; el mismo pool pedido dos veces se suma', async () => {
      const trip = await openTrip();
      const libre = trip.pools['LIBRE:PERSONS'] as string;
      const h = holder();
      await sell(trip, {
        holderId: h,
        resourceCodes: ['3A', '3B'],
        pools: [
          { poolId: libre, quantity: 2 },
          { poolId: libre, quantity: 3 },
        ],
        fromSeq: 1,
        toSeq: 3,
      });
      let avail = await availability(trip);
      expect(avail.pools.find((p: { id: string }) => p.id === libre).used).toEqual([0, 5, 5]);
      expect(avail.resources.find((r: { code: string }) => r.code === '3A').free).toEqual([
        true,
        false,
        false,
      ]);
      await inA(() => engine.release([h]));
      avail = await availability(trip);
      expect(avail.pools.find((p: { id: string }) => p.id === libre).used).toEqual([0, 0, 0]);
      expect(avail.resources.find((r: { code: string }) => r.code === '3A').free).toEqual([true, true, true]);
    });
  });

  let apiTrip: OpenTrip;
  const block = (trip: OpenTrip, over: object = {}, c: Company = a, userId?: string) =>
    as(
      c,
      'post',
      `/api/v1/trips/${trip.id}/blocks`,
      {
        reason: 'CREW',
        note: null,
        fromSeq: 0,
        toSeq: 2,
        resourceCodes: [],
        pools: [],
        expiresAt: null,
        ...over,
      },
      userId,
    );
  const expectError = (res: request.Response, status: number, code: string, message?: string) => {
    expect([res.status, res.body.error?.code]).toEqual([status, code]);
    if (message !== undefined) expect(res.body.error.message).toBe(message);
  };

  it('bloqueos por la API: ocupan recursos y cupos en sus tramos; la disponibilidad lo muestra tramo por tramo', async () => {
    apiTrip = await openTrip();
    const libre = apiTrip.pools['LIBRE:PERSONS'] as string;
    const crew = await block(apiTrip, {
      note: ' Tripulación de relevo ',
      resourceCodes: ['1A', '1B'],
      pools: [{ poolId: libre, quantity: 2 }],
    });
    expect(crew.status).toBe(201);
    expect(crew.body).toMatchObject({
      tripId: apiTrip.id,
      reason: 'CREW',
      note: 'Tripulación de relevo',
      fromSeq: 0,
      toSeq: 2,
      resourceCodes: ['1A', '1B'],
      pools: [{ poolId: libre, quantity: 2 }],
      expiresAt: null,
      state: 'ACTIVE',
      releasedAt: null,
    });
    const cabinBlock = await block(apiTrip, {
      reason: 'MAINTENANCE',
      resourceCodes: ['C1'],
      fromSeq: 1,
      toSeq: 3,
    });
    expect(cabinBlock.body.resourceCodes).toEqual(['C1-B1', 'C1-B2', 'C1-B3', 'C1-B4']);

    const avail = await availability(apiTrip);
    expect(avail.segments).toEqual([
      { seq: 0, from: 'Pucallpa', to: 'Contamana' },
      { seq: 1, from: 'Contamana', to: 'Yurimaguas' },
      { seq: 2, from: 'Yurimaguas', to: 'Iquitos' },
    ]);
    const free = (code: string) => avail.resources.find((r: { code: string }) => r.code === code).free;
    expect([free('1A'), free('1B'), free('1C'), free('C1'), free('C1-B2'), free('C3')]).toEqual([
      [false, false, true],
      [false, false, true],
      [true, true, true],
      [true, false, false],
      [true, false, false],
      [true, true, true],
    ]);
    const pool = avail.pools.find((p: { id: string }) => p.id === libre);
    expect([pool.capacity, pool.used, pool.free]).toEqual([10, [2, 2, 0], [8, 8, 10]]);

    // Lo ocupado, con el tramo y los códigos; lo contiguo sí cabe.
    expectError(
      await block(apiTrip, { resourceCodes: ['1B', '1C'], fromSeq: 1, toSeq: 3 }),
      409,
      'RESOURCE_UNAVAILABLE',
      // El tramo exacto donde choca (1B está ocupado de Pucallpa a Yurimaguas), no todo lo pedido.
      'Ocupado entre Contamana y Yurimaguas: 1B',
    );
    expect((await block(apiTrip, { resourceCodes: ['C1-B1'], fromSeq: 0, toSeq: 1 })).status).toBe(201);
    expectError(
      await block(apiTrip, { pools: [{ poolId: libre, quantity: 9 }], fromSeq: 1, toSeq: 3 }),
      409,
      'CAPACITY_EXCEEDED',
      'La zona LIBRE (personas) sin capacidad entre Contamana y Yurimaguas',
    );
    // Nada de lo rechazado quedó a medias.
    expect(free('1C')).toEqual([true, true, true]);
    expect((await availability(apiTrip)).pools.find((p: { id: string }) => p.id === libre).used).toEqual([
      2, 2, 0,
    ]);

    const list = await as(a, 'get', `/api/v1/trips/${apiTrip.id}/blocks`);
    expect(list.body.blocks.map((b: { reason: string; state: string }) => [b.reason, b.state])).toEqual([
      ['CREW', 'ACTIVE'],
      ['MAINTENANCE', 'ACTIVE'],
      ['CREW', 'ACTIVE'],
    ]);
    const author = await inTenant(a, (c) =>
      c.query('SELECT created_by_kind::text AS kind FROM trip_blocks WHERE id = $1', [crew.body.id]),
    );
    expect(author.rows[0]).toEqual({ kind: 'MEMBERSHIP' });

    // Liberar: vuelve a estar libre; una vez liberado, no se libera de nuevo.
    const released = await as(a, 'post', `/api/v1/trips/${apiTrip.id}/blocks/${crew.body.id}/release`);
    expect([released.status, released.body.state]).toEqual([200, 'RELEASED']);
    expect(released.body.releasedAt).not.toBeNull();
    expectError(
      await as(a, 'post', `/api/v1/trips/${apiTrip.id}/blocks/${crew.body.id}/release`),
      409,
      'CONFLICT',
      'El bloqueo ya está liberado',
    );
    const after = await availability(apiTrip);
    expect(after.resources.find((r: { code: string }) => r.code === '1A').free).toEqual([true, true, true]);
    expect(after.pools.find((p: { id: string }) => p.id === libre).used).toEqual([0, 0, 0]);
  });

  it('bloqueos: validación del tramo, los recursos, los cupos, el vencimiento y el estado del viaje', async () => {
    const libre = apiTrip.pools['LIBRE:PERSONS'] as string;
    const other = await openTrip();
    expect((await block(apiTrip, { resourceCodes: ['1A'], fromSeq: 2, toSeq: 2 })).status).toBe(400);
    expect((await block(apiTrip, {})).status).toBe(400);
    expect((await block(apiTrip, { resourceCodes: ['1A', '1A'] })).status).toBe(400);
    expect((await block(apiTrip, { reason: 'PARTY', resourceCodes: ['1A'] })).status).toBe(400);
    expectError(
      await block(apiTrip, { resourceCodes: ['1A'], toSeq: 4 }),
      400,
      'VALIDATION_FAILED',
      'Ese tramo no es del viaje',
    );
    expectError(
      await block(apiTrip, { resourceCodes: ['1A', 'ZZ9'] }),
      400,
      'VALIDATION_FAILED',
      'El viaje no tiene ZZ9',
    );
    expectError(
      await block(apiTrip, { pools: [{ poolId: other.pools['LIBRE:PERSONS'], quantity: 1 }] }),
      400,
      'VALIDATION_FAILED',
      'Uno de los cupos no es de este viaje',
    );
    expectError(
      await block(apiTrip, { resourceCodes: ['1A'], expiresAt: new Date(Date.now() - 1000).toISOString() }),
      400,
      'VALIDATION_FAILED',
      'El vencimiento es posterior a este momento',
    );
    // Con vencimiento: retención (HELD) que vence.
    const courtesy = await block(apiTrip, {
      reason: 'COURTESY',
      resourceCodes: ['2A'],
      pools: [{ poolId: libre, quantity: 1 }],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect([courtesy.status, courtesy.body.state]).toEqual([201, 'ACTIVE']);
    const held = await inTenant(a, (c) =>
      c.query('SELECT status::text AS status FROM resource_allocations WHERE holder_id = $1', [
        courtesy.body.id,
      ]),
    );
    expect(held.rows).toEqual([{ status: 'HELD' }]);
    // Un viaje que no está a la venta no se bloquea.
    const planned = await as(a, 'post', '/api/v1/trips', {
      routeId,
      departureLocal: at(300, '08:00'),
      vehicleId: null,
      layout: null,
      minPassengers: null,
      confirmationDeadlineLocal: null,
    });
    expectError(
      await as(a, 'post', `/api/v1/trips/${planned.body.id}/blocks`, {
        reason: 'CREW',
        note: null,
        fromSeq: 0,
        toSeq: 1,
        resourceCodes: ['1A'],
        pools: [],
        expiresAt: null,
      }),
      409,
      'CONFLICT',
      'El viaje no está a la venta',
    );
    expect((await as(a, 'post', `/api/v1/trips/${apiTrip.id}/blocks/no-es-un-id/release`)).status).toBe(404);
  });

  it('viajes con ocupación: no vuelven a planificado ni se cancelan; con historia, su unidad y su plano no cambian', async () => {
    const trip = await openTrip();
    const b1 = await block(trip, { resourceCodes: ['5A'] });
    const message = 'El viaje tiene ocupación (bloqueos o ventas): libérala antes';
    expectError(await as(a, 'post', `/api/v1/trips/${trip.id}/back-to-planned`), 409, 'CONFLICT', message);
    expectError(
      await as(a, 'post', `/api/v1/trips/${trip.id}/cancel`, { reason: 'Prueba' }),
      409,
      'CONFLICT',
      message,
    );
    expect((await as(a, 'post', `/api/v1/trips/${trip.id}/blocks/${b1.body.id}/release`)).status).toBe(200);
    expect((await as(a, 'post', `/api/v1/trips/${trip.id}/back-to-planned`)).status).toBe(200);
    const detail = (await as(a, 'get', `/api/v1/trips/${trip.id}`)).body;
    expectError(
      await as(a, 'put', `/api/v1/trips/${trip.id}`, {
        departureLocal: detail.departureLocal,
        vehicleId: null,
        layout: null,
        minPassengers: null,
        confirmationDeadlineLocal: null,
      }),
      409,
      'CONFLICT',
      'El viaje ya tuvo ocupación: su unidad y su plano no cambian',
    );
    // Mover solo la hora sí se puede (no toca el inventario).
    const moved = await as(a, 'put', `/api/v1/trips/${trip.id}`, {
      departureLocal: detail.departureLocal.replace('08:00', '09:00'),
      vehicleId: ids.lancha,
      layout: null,
      minPassengers: null,
      confirmationDeadlineLocal: null,
    });
    expect(moved.status).toBe(200);
    expect((await as(a, 'post', `/api/v1/trips/${trip.id}/cancel`, { reason: 'Sin pasajeros' })).status).toBe(
      200,
    );
  });

  it('reglas de la base: exclusión, viaje a la venta, tramos, camarote por camas, transiciones, CHECK y privilegios', async () => {
    const trip = await openTrip();
    const ids2 = await inTenant(a, async (c) => ({
      seat: (await c.query(`SELECT id FROM trip_resources WHERE trip_id = $1 AND code = '6A'`, [trip.id]))
        .rows[0].id,
      cabin: (await c.query(`SELECT id FROM trip_resources WHERE trip_id = $1 AND code = 'C1'`, [trip.id]))
        .rows[0].id,
    }));
    const insert = (c: PoolClient, over: Record<string, unknown> = {}) => {
      const v = {
        resource: ids2.seat,
        range: '[0,2)',
        status: 'CONFIRMED',
        expires: null,
        trip: trip.id,
        ...over,
      };
      return c.query(
        `INSERT INTO resource_allocations (id, tenant_id, trip_id, trip_resource_id, stop_range, status, hold_expires_at,
                                           holder_type, holder_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::int4range, $5, $6, 'BLOCK', gen_random_uuid()) RETURNING id`,
        [a.id, v.trip, v.resource, v.range, v.status, v.expires],
      );
    };
    const rejects = (
      fn: (c: PoolClient) => Promise<unknown>,
      code: string,
      message?: string,
      commit = false,
    ) => expect(inTenant(a, fn, commit)).rejects.toMatchObject(message ? { code, message } : { code });

    await rejects(async (c) => {
      await insert(c);
      await insert(c, { range: '[1,3)' });
    }, '23P01');
    await inTenant(a, async (c) => {
      await insert(c, { range: '[0,1)' });
      await insert(c, { range: '[1,3)' });
    });
    await rejects(
      (c) => insert(c, { range: '[2,4)' }),
      'P0001',
      'resource_allocations: el rango está fuera de los tramos del viaje',
    );
    await rejects(
      (c) => insert(c, { resource: ids2.cabin }),
      'P0001',
      'resource_allocations: el recurso no se vende solo (un camarote se vende por sus camas)',
    );
    await rejects(
      (c) => insert(c, { status: 'RELEASED' }),
      'P0001',
      'resource_allocations: una asignación nace retenida o confirmada',
    );
    await rejects((c) => insert(c, { status: 'HELD' }), '23514');
    await rejects((c) => insert(c, { range: 'empty' }), '23514');
    // Liberada es definitiva; las transiciones permitidas son HELD → CONFIRMED | RELEASED y CONFIRMED → RELEASED.
    await rejects(
      async (c) => {
        const id = (await insert(c)).rows[0].id;
        await c.query(
          `UPDATE resource_allocations SET status = 'RELEASED', released_at = now() WHERE id = $1`,
          [id],
        );
        await c.query(
          `UPDATE resource_allocations SET status = 'CONFIRMED', released_at = NULL WHERE id = $1`,
          [id],
        );
      },
      'P0001',
      'resource_allocations: una asignación liberada no cambia',
    );
    await rejects(async (c) => {
      const id = (await insert(c)).rows[0].id;
      await c.query(
        `UPDATE resource_allocations SET status = 'HELD', hold_expires_at = now() WHERE id = $1`,
        [id],
      );
    }, '42501');
    for (const sql of [
      `UPDATE resource_allocations SET stop_range = '[0,1)' WHERE trip_id = $1`,
      `DELETE FROM resource_allocations WHERE trip_id = $1`,
      `DELETE FROM pool_allocations WHERE pool_id IN (SELECT id FROM trip_capacity_pools WHERE trip_id = $1)`,
      `UPDATE trip_blocks SET reason = 'OTHER' WHERE trip_id = $1`,
      `DELETE FROM trip_blocks WHERE trip_id = $1`,
    ]) {
      await rejects((c) => c.query(sql, [trip.id]), '42501');
    }
    // Un viaje planificado no tiene ocupación (coherencia diferida, al confirmar).
    await rejects(
      async (c) => {
        await insert(c);
        await c.query(
          `UPDATE trips SET status = 'PLANNED', opened_at = NULL, opened_by_kind = NULL, opened_by_id = NULL WHERE id = $1`,
          [trip.id],
        );
        await c.query(
          `DELETE FROM trip_pool_segment_usage WHERE pool_id IN (SELECT id FROM trip_capacity_pools WHERE trip_id = $1)`,
          [trip.id],
        );
      },
      'P0001',
      'trips: un viaje planificado no tiene ocupación',
      true,
    );
    // El contador nunca supera la capacidad, aunque se escriba directo con yebo_app.
    await rejects(
      (c) =>
        c.query(
          `UPDATE trip_pool_segment_usage SET used = capacity + 1
            WHERE pool_id IN (SELECT id FROM trip_capacity_pools WHERE trip_id = $1)`,
          [trip.id],
        ),
      '23514',
    );
  });

  it('aislamiento: otra empresa no ve la disponibilidad ni los bloqueos, ni bloquea (404), ni por RLS', async () => {
    expect((await as(b, 'get', `/api/v1/trips/${apiTrip.id}/availability`)).status).toBe(404);
    expect((await as(b, 'get', `/api/v1/trips/${apiTrip.id}/blocks`)).status).toBe(404);
    expect((await block(apiTrip, { resourceCodes: ['4A'] }, b)).status).toBe(404);
    const someBlock = (await as(a, 'get', `/api/v1/trips/${apiTrip.id}/blocks`)).body.blocks[0].id;
    expect((await as(b, 'post', `/api/v1/trips/${apiTrip.id}/blocks/${someBlock}/release`)).status).toBe(404);
    for (const table of ['resource_allocations', 'pool_allocations', 'trip_blocks']) {
      expect(
        await inTenant(b, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n),
      ).toBe(0);
    }
    // El motor tampoco: en el contexto de B, el viaje de A no existe.
    const asB = await cls.run(async () => {
      cls.set('tenantId', b.id);
      return outcome(
        engine.allocate({
          tripId: apiTrip.id,
          fromSeq: 0,
          toSeq: 1,
          holderType: 'BLOCK',
          holderId: holder(),
          resourceCodes: ['4A'],
        }),
      );
    });
    expect(asB).toBe('NOT_FOUND');
  });

  it('permisos: sin trips.block → 403; sin sesión → 401; con la empresa suspendida, los bloqueos (FULFILL) siguen', async () => {
    const userId = (
      await seed.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), 'cajera@inv-a.pe', 'x', 'Cajera', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0]?.id as string;
    await seed.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [a.id, userId],
    );
    expect((await as(a, 'get', `/api/v1/trips/${apiTrip.id}/blocks`, undefined, userId)).status).toBe(403);
    expect((await block(apiTrip, { resourceCodes: ['4A'] }, a, userId)).status).toBe(403);
    expect((await as(a, 'get', `/api/v1/trips/${apiTrip.id}/availability`, undefined, userId)).status).toBe(
      403,
    );
    expect((await http().get(`/api/v1/trips/${apiTrip.id}/blocks`).set('Host', a.host)).status).toBe(401);

    const to = (status: string) =>
      asStaff('post', `/api/v1/platform/tenants/${a.id}/status`, { to: status, reason: 'Prueba 7.4' });
    expect((await to('PAST_DUE')).status).toBe(200);
    expect((await to('SUSPENDED')).status).toBe(200);
    try {
      const created = await block(apiTrip, { reason: 'MAINTENANCE', resourceCodes: ['4A'] });
      expect(created.status).toBe(201);
      expect(
        (await as(a, 'post', `/api/v1/trips/${apiTrip.id}/blocks/${created.body.id}/release`)).status,
      ).toBe(200);
      expect((await as(a, 'get', `/api/v1/trips/${apiTrip.id}/availability`)).status).toBe(200);
    } finally {
      expect((await to('ACTIVE')).status).toBe(200);
    }
  });
});
