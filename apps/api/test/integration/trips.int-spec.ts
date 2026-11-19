/**
 * Fase 7.3a · Viajes (data-dictionary §5; F7-Q3, F7-Q4 y F7-Q6; capacity-and-inventory §2–4). PostgreSQL y Redis
 * reales: viajes puntuales con las paradas de la ruta copiadas y sus horas locales, unidad y plano (el asignado o uno
 * elegido), inventario materializado igual a deriveInventory, editar mientras está planificado, abrir a la venta (un
 * contador por pool y tramo), volver a planificar y cancelar; reglas de la base (estados, lo fijo desde la apertura,
 * coherencia diferida, EXCLUDE del vehículo, CHECK y privilegios), aislamiento (RLS), permisos y estados del tenant.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { boatTemplate, busTemplate, deriveInventory, fastBoatTemplate } from '@yebo/contracts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { PERMISSION_CODES } from '../../src/modules/access/permission-catalog';
import { SessionService } from '../../src/modules/identity/session.service';
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

describe('Fase 7.3a · viajes', () => {
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
      await seedPlatformSession(seed, { email: 'viajes@yebo.pe', role: 'SUPERADMIN', now: new Date() })
    ).cookie;
    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'viajes', name: 'Viajes' });
    const v = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
      basePrice: '99.00',
      billingInterval: 'MONTHLY',
      includedUsers: 5,
      extraUserPrice: '15.00',
      trialDays: 0,
      modules: ['PASSENGERS'],
    });
    await asStaff('post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
    a = await company('viajes-a', v.body.id);
    b = await company('viajes-b', v.body.id);
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
  const code = (offset: number, time: string) =>
    `PCL-IQT-${day(offset).slice(2).replaceAll('-', '')}-${time.replace(':', '')}`;

  let routeId = '';
  const ids = {
    lancha: '',
    lancha2: '',
    bus: '',
    boatLayout: '',
    fastLayout: '',
    draftLayout: '',
    busLayout: '',
  };
  let tripId = '';

  const trip = (over: object = {}) => ({
    routeId,
    departureLocal: at(3, '08:00'),
    vehicleId: ids.lancha,
    layout: null,
    minPassengers: null,
    confirmationDeadlineLocal: null,
    ...over,
  });
  const edit = (over: object = {}) => {
    const { routeId: _r, ...rest } = trip(over);
    return rest;
  };
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
  /** Edición de un vehículo: los mismos campos, sin el código (no cambia). */
  const update = (code: string, typeId: string, status = 'ACTIVE') => {
    const { code: _code, ...rest } = vehicleBody(code, typeId, status);
    return rest;
  };
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
  const sortBy = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((x, y) => (key(x) < key(y) ? -1 : 1));
  const expectError = (res: request.Response, status: number, message?: string) => {
    expect([res.status, message === undefined ? undefined : res.body.error?.message]).toEqual([
      status,
      message,
    ]);
  };

  it('crear: copia las paradas con sus horas locales, fija la unidad y su plano asignado e inventario = deriveInventory', async () => {
    const route = await as(a, 'post', '/api/v1/routes', {
      code: 'PCL-IQT',
      name: 'Pucallpa – Iquitos',
      modality: 'RIVER',
      stops: amazonas(),
    });
    expect(route.status).toBe(201);
    routeId = route.body.id;
    ids.boatLayout = await layout('Lancha', 'RIVER', boatTemplate());
    ids.fastLayout = await layout('Lancha rápida', 'RIVER', fastBoatTemplate());
    ids.draftLayout = await layout('Borrador', 'RIVER', boatTemplate(), false);
    ids.busLayout = await layout('Bus', 'LAND', busTemplate());
    ids.lancha = await vehicle('LANCHA-01', 'RIVER', ids.boatLayout);
    ids.lancha2 = await vehicle('LANCHA-02', 'RIVER', null);
    ids.bus = await vehicle('BUS-01', 'LAND', ids.busLayout);

    const created = await as(
      a,
      'post',
      '/api/v1/trips',
      trip({ minPassengers: 20, confirmationDeadlineLocal: at(2, '18:00') }),
    );
    expect(created.status).toBe(201);
    tripId = created.body.id;
    expect(created.body).toMatchObject({
      code: code(3, '08:00'),
      routeCode: 'PCL-IQT',
      modality: 'RIVER',
      departureKind: 'ON_DEMAND',
      serviceMode: 'SHARED',
      status: 'PLANNED',
      departureLocal: at(3, '08:00'),
      arrivalLocal: at(6, '20:00'),
      plannedDepartureAt: `${day(3)}T13:00:00.000Z`,
      vehicle: { id: ids.lancha, code: 'LANCHA-01', name: 'LANCHA-01' },
      layout: { layoutId: ids.boatLayout, name: 'Lancha', version: 1 },
      minPassengers: 20,
      confirmationDeadlineLocal: at(2, '18:00'),
      openedAt: null,
      cancelledAt: null,
    });
    // Minutos de la ruta: Contamana 720 (+60 de parada), Yurimaguas 2160 (+120), Iquitos 5040.
    expect(
      created.body.stops.map((s: Record<string, unknown>) => [
        s.seq,
        s.locationName,
        s.arrivalLocal,
        s.departureLocal,
        s.allowsBoarding,
        s.allowsAlighting,
      ]),
    ).toEqual([
      [0, 'Pucallpa', null, at(3, '08:00'), true, false],
      [1, 'Contamana', at(3, '20:00'), at(3, '21:00'), true, true],
      [2, 'Yurimaguas', at(4, '20:00'), at(4, '22:00'), true, true],
      [3, 'Iquitos', at(6, '20:00'), null, false, true],
    ]);

    const derived = deriveInventory(boatTemplate());
    expect(created.body.inventory).toMatchObject({
      resources: derived.resources.length,
      sellableResources: derived.resources.filter((r) => r.isSellable).length,
      segmentRows: 0,
    });
    const inv = await as(a, 'get', `/api/v1/trips/${tripId}/inventory`);
    expect(inv.status).toBe(200);
    expect(sortBy(inv.body.resources, (r: { code: string }) => r.code)).toEqual(
      sortBy(
        derived.resources.map((r) => ({
          code: r.code,
          kind: r.kind,
          zoneCode: r.zoneCode,
          parentCode: r.parentCode,
          priceClassCode: r.priceClassCode,
          capacity: r.capacity,
          isSellable: r.isSellable,
          sellableAsUnit: r.sellableAsUnit,
        })),
        (r) => r.code,
      ),
    );
    const poolKey = (p: { scope: string; zoneCode: string | null; dimension: string }) =>
      `${p.scope}|${p.zoneCode ?? ''}|${p.dimension}`;
    expect(
      sortBy(
        inv.body.pools.map(({ id: _id, usage, ...p }: { id: string; usage: unknown[] }) => {
          expect(usage).toEqual([]);
          return p;
        }),
        poolKey,
      ),
    ).toEqual(sortBy(derived.pools, poolKey));
    expect(inv.body.segments).toEqual([
      { seq: 0, from: 'Pucallpa', to: 'Contamana' },
      { seq: 1, from: 'Contamana', to: 'Yurimaguas' },
      { seq: 2, from: 'Yurimaguas', to: 'Iquitos' },
    ]);
    // En la base: el elemento del plano de cada recurso y la cama con su camarote.
    const links = await inTenant(a, (c) =>
      c.query<{ n: number; parents: number }>(
        `SELECT count(*)::int AS n, count(r.parent_trip_resource_id)::int AS parents
           FROM trip_resources r JOIN layout_elements e ON e.id = r.layout_element_id AND e.code = r.code
          WHERE r.trip_id = $1`,
        [tripId],
      ),
    );
    expect(links.rows[0]).toEqual({
      n: derived.resources.length,
      parents: derived.resources.filter((r) => r.parentCode).length,
    });

    // Editar la ruta después no cambia el viaje.
    const stops = amazonas().filter((s) => s.locationId !== loc.yurimaguas);
    expect(
      (await as(a, 'put', `/api/v1/routes/${routeId}`, { name: 'Pucallpa – Iquitos', stops })).status,
    ).toBe(200);
    expect((await as(a, 'get', `/api/v1/trips/${tripId}`)).body.stops).toHaveLength(4);
    expect(
      (await as(a, 'put', `/api/v1/routes/${routeId}`, { name: 'Pucallpa – Iquitos', stops: amazonas() }))
        .status,
    ).toBe(200);

    const list = await as(a, 'get', `/api/v1/trips?from=${day(3)}&to=${day(3)}`);
    expect(list.body.trips.map((t: { id: string }) => t.id)).toEqual([tripId]);
    expect((await as(a, 'get', `/api/v1/trips?from=${day(4)}&to=${day(10)}`)).body.trips).toEqual([]);
    expect(
      (await as(a, 'get', `/api/v1/trips?from=${day(0)}&to=${day(10)}&routeId=${routeId}&status=PLANNED`))
        .body.trips,
    ).toHaveLength(1);
    expect((await as(a, 'get', `/api/v1/trips?from=${day(0)}&to=${day(70)}`)).status).toBe(400);
    expect((await as(a, 'get', `/api/v1/trips?from=${day(5)}&to=${day(1)}`)).status).toBe(400);
  });

  it('unidad y plano: la modalidad, el horario libre, una versión publicada elegida o ninguna; reglas de la salida', async () => {
    const post = (over: object) => as(a, 'post', '/api/v1/trips', trip(over));
    expectError(
      await post({ departureLocal: at(-1, '08:00') }),
      400,
      'La salida es posterior a este momento',
    );
    expectError(await post({ departureLocal: at(500, '08:00') }), 400, 'La salida es como mucho a 400 días');
    expectError(await post({ vehicleId: ids.bus }), 400, 'La unidad BUS-01 es de otra modalidad que la ruta');
    expectError(
      await post({ departureLocal: at(5, '08:00') }),
      409,
      `La unidad LANCHA-01 ya está en el viaje ${code(3, '08:00')} en ese horario`,
    );
    expectError(
      await post({ vehicleId: null, departureLocal: at(3, '08:00') }),
      409,
      `La ruta ya tiene el viaje ${code(3, '08:00')} a esa hora`,
    );
    expectError(
      await post({
        vehicleId: ids.lancha2,
        departureLocal: at(10, '08:00'),
        layout: { layoutId: ids.draftLayout, version: 1 },
      }),
      400,
      'Solo se usa una versión publicada del plano',
    );
    expectError(
      await post({
        vehicleId: ids.lancha2,
        departureLocal: at(10, '08:00'),
        layout: { layoutId: ids.busLayout, version: 1 },
      }),
      400,
      'El plano es de otra modalidad que la unidad',
    );
    expect((await post({ vehicleId: null, layout: { layoutId: ids.boatLayout, version: 1 } })).status).toBe(
      400,
    );
    expect((await post({ confirmationDeadlineLocal: at(3, '08:00') })).status).toBe(400);
    expect((await post({ routeId: '0190f0a0-0000-7000-8000-000000000999' })).status).toBe(400);

    // Sin plano asignado ni elegido: el viaje se crea sin inventario.
    const bare = await post({ vehicleId: ids.lancha2, departureLocal: at(10, '08:00') });
    expect(bare.status).toBe(201);
    expect([bare.body.layout, bare.body.inventory]).toEqual([null, null]);
    // Con un plano elegido: su inventario.
    const chosen = await post({
      vehicleId: ids.lancha2,
      departureLocal: at(20, '08:00'),
      layout: { layoutId: ids.fastLayout, version: 1 },
    });
    expect(chosen.status).toBe(201);
    expect(chosen.body.layout).toMatchObject({ name: 'Lancha rápida' });
    expect(chosen.body.inventory.resources).toBe(deriveInventory(fastBoatTemplate()).resources.length);
    // Sin unidad.
    const noUnit = await post({ vehicleId: null, departureLocal: at(30, '06:15') });
    expect([noUnit.status, noUnit.body.vehicle, noUnit.body.code]).toEqual([201, null, code(30, '06:15')]);

    // Ruta archivada.
    const other = await as(a, 'post', '/api/v1/routes', {
      code: 'CTM-YMS',
      name: 'Contamana – Yurimaguas',
      modality: 'RIVER',
      stops: [stop('contamana', 0), stop('yurimaguas', 600)],
    });
    expect((await as(a, 'post', `/api/v1/routes/${other.body.id}/archive`)).status).toBe(200);
    expectError(
      await post({ routeId: other.body.id, vehicleId: null }),
      409,
      'La ruta está archivada: restáurala antes de crear viajes',
    );
    // Unidad retirada.
    const retired = await vehicle('LANCHA-99', 'RIVER', null);
    expect(
      (
        await as(
          a,
          'put',
          `/api/v1/vehicles/${retired}`,
          update('LANCHA-99', types.RIVER as string, 'RETIRED'),
        )
      ).status,
    ).toBe(200);
    expectError(
      await post({ vehicleId: retired, departureLocal: at(40, '08:00') }),
      400,
      'La unidad LANCHA-99 está retirada',
    );
  });

  it('editar (planificado): mover la salida corre las paradas y el código; cambiar el plano reemplaza el inventario', async () => {
    const moved = await as(a, 'put', `/api/v1/trips/${tripId}`, edit({ departureLocal: at(3, '09:30') }));
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      code: code(3, '09:30'),
      departureLocal: at(3, '09:30'),
      arrivalLocal: at(6, '21:30'),
    });
    expect(moved.body.stops.map((s: Record<string, unknown>) => [s.arrivalLocal, s.departureLocal])).toEqual([
      [null, at(3, '09:30')],
      [at(3, '21:30'), at(3, '22:30')],
      [at(4, '21:30'), at(4, '23:30')],
      [at(6, '21:30'), null],
    ]);
    const fast = await as(
      a,
      'put',
      `/api/v1/trips/${tripId}`,
      edit({ departureLocal: at(3, '09:30'), layout: { layoutId: ids.fastLayout, version: 1 } }),
    );
    expect(fast.body.layout.name).toBe('Lancha rápida');
    expect(fast.body.inventory.resources).toBe(deriveInventory(fastBoatTemplate()).resources.length);
    const none = await as(
      a,
      'put',
      `/api/v1/trips/${tripId}`,
      edit({ departureLocal: at(3, '09:30'), vehicleId: null }),
    );
    expect([none.body.vehicle, none.body.inventory]).toEqual([null, null]);
    expect(
      (
        await inTenant(a, (c) =>
          c.query('SELECT count(*)::int AS n FROM trip_resources WHERE trip_id = $1', [tripId]),
        )
      ).rows[0].n,
    ).toBe(0);
    // De vuelta: la lancha con su plano asignado a las 08:00.
    const back = await as(a, 'put', `/api/v1/trips/${tripId}`, edit());
    expect([back.status, back.body.code, back.body.layout.name]).toEqual([200, code(3, '08:00'), 'Lancha']);
  });

  it('abrir a la venta: contadores por pool y tramo; queda fijo; volver a planificar; cancelar con motivo (definitivo)', async () => {
    const pools = deriveInventory(boatTemplate()).pools;
    const open = await as(a, 'post', `/api/v1/trips/${tripId}/open`);
    expect(open.status).toBe(200);
    expect(open.body.status).toBe('OPEN_FOR_SALE');
    expect(open.body.openedAt).not.toBeNull();
    expect(open.body.inventory.segmentRows).toBe(pools.length * 3);
    const inv = (await as(a, 'get', `/api/v1/trips/${tripId}/inventory`)).body;
    for (const p of inv.pools) {
      expect(p.usage).toEqual([0, 1, 2].map((seq) => ({ seq, capacity: p.capacity, used: 0 })));
    }
    expectError(await as(a, 'post', `/api/v1/trips/${tripId}/open`), 409, 'El viaje ya está a la venta');
    expectError(
      await as(a, 'put', `/api/v1/trips/${tripId}`, edit()),
      409,
      'Solo se edita un viaje planificado',
    );
    const opener = await inTenant(a, (c) =>
      c.query('SELECT opened_by_kind::text AS kind FROM trips WHERE id = $1', [tripId]),
    );
    expect(opener.rows[0]).toEqual({ kind: 'MEMBERSHIP' });

    const back = await as(a, 'post', `/api/v1/trips/${tripId}/back-to-planned`);
    expect([back.status, back.body.status, back.body.openedAt, back.body.inventory.segmentRows]).toEqual([
      200,
      'PLANNED',
      null,
      0,
    ]);
    expectError(
      await as(a, 'post', `/api/v1/trips/${tripId}/back-to-planned`),
      409,
      'Solo vuelve a planificado un viaje a la venta',
    );

    // Sin plano, no se abre; con la unidad en mantenimiento, tampoco.
    const bare = (await as(a, 'get', `/api/v1/trips?from=${day(10)}&to=${day(10)}`)).body.trips[0];
    expectError(
      await as(a, 'post', `/api/v1/trips/${bare.id}/open`),
      400,
      'Asigna una unidad con plano antes de abrir la venta',
    );
    expect(
      (
        await as(
          a,
          'put',
          `/api/v1/vehicles/${ids.lancha}`,
          update('LANCHA-01', types.RIVER as string, 'MAINTENANCE'),
        )
      ).status,
    ).toBe(200);
    expectError(
      await as(a, 'post', `/api/v1/trips/${tripId}/open`),
      409,
      'La unidad LANCHA-01 está en mantenimiento',
    );
    expect(
      (await as(a, 'put', `/api/v1/vehicles/${ids.lancha}`, update('LANCHA-01', types.RIVER as string)))
        .status,
    ).toBe(200);

    expect((await as(a, 'post', `/api/v1/trips/${tripId}/open`)).status).toBe(200);
    expect((await as(a, 'post', `/api/v1/trips/${tripId}/cancel`, { reason: ' ' })).status).toBe(400);
    const cancelled = await as(a, 'post', `/api/v1/trips/${tripId}/cancel`, {
      reason: ' Creciente del río ',
    });
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Creciente del río' });
    expect(cancelled.body.cancelledAt).not.toBeNull();
    expectError(
      await as(a, 'post', `/api/v1/trips/${tripId}/cancel`, { reason: 'Otra vez' }),
      409,
      'El viaje ya está cancelado',
    );
    expectError(
      await as(a, 'post', `/api/v1/trips/${tripId}/open`),
      409,
      'Solo se abre a la venta un viaje planificado',
    );
    expectError(
      await as(a, 'put', `/api/v1/trips/${tripId}`, edit()),
      409,
      'Solo se edita un viaje planificado',
    );

    // Cancelado, libera la hora de la ruta y la unidad: el nuevo viaje lleva el código con -2.
    const again = await as(a, 'post', '/api/v1/trips', trip());
    expect([again.status, again.body.code]).toEqual([201, `${code(3, '08:00')}-2`]);
    // Un viaje planificado también se cancela.
    expect(
      (await as(a, 'post', `/api/v1/trips/${again.body.id}/cancel`, { reason: 'Sin carga' })).status,
    ).toBe(200);
  });

  it('reglas de la base: estados, lo fijo desde la apertura, coherencia al confirmar, EXCLUDE de la unidad, CHECK y privilegios', async () => {
    const list = (await as(a, 'get', `/api/v1/trips?from=${day(0)}&to=${day(40)}`)).body.trips as {
      id: string;
      status: string;
      code: string;
    }[];
    const planned = list.find((t) => t.status === 'PLANNED' && t.code === code(20, '08:00'))?.id as string;
    // Uno a la venta, para las reglas desde la apertura.
    expect((await as(a, 'post', `/api/v1/trips/${planned}/open`)).status).toBe(200);
    const rejects = (
      fn: (c: PoolClient) => Promise<unknown>,
      code: string,
      message?: string,
      commit = false,
    ) => expect(inTenant(a, fn, commit)).rejects.toMatchObject(message ? { code, message } : { code });

    const insertTrip = (c: PoolClient, extra: Record<string, unknown> = {}) => {
      const v = {
        code: 'DB-1',
        status: 'PLANNED',
        vehicle: null,
        dep: `${day(50)}T13:00:00Z`,
        arr: `${day(51)}T13:00:00Z`,
        mode: 'SHARED',
        ...extra,
      };
      return c.query<{ id: string }>(
        `INSERT INTO trips (id, tenant_id, code, route_id, status, vehicle_id, planned_departure_at, planned_arrival_at, service_mode)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [a.id, v.code, routeId, v.status, v.vehicle, v.dep, v.arr, v.mode],
      );
    };
    await rejects(
      (c) => insertTrip(c, { status: 'OPEN_FOR_SALE' }),
      'P0001',
      'trips: un viaje nace planificado',
    );
    await rejects((c) => insertTrip(c, { mode: 'PRIVATE' }), '23514');
    await rejects((c) => insertTrip(c, { arr: `${day(50)}T13:00:00Z` }), '23514');
    await rejects((c) => insertTrip(c, { code: 'minúsculas' }), '23514');
    // Sin paradas no se confirma (coherencia diferida).
    await rejects(
      (c) => insertTrip(c),
      'P0001',
      'trips: las paradas del viaje van de 0 a n-1 y son al menos dos',
      true,
    );
    // La misma unidad en un horario que se solapa con otro viaje suyo.
    const busy = list.find((t) => t.code === code(10, '08:00'))?.id as string;
    await rejects(
      (c) =>
        insertTrip(c, { vehicle: ids.lancha2, dep: `${day(10)}T20:00:00Z`, arr: `${day(11)}T13:00:00Z` }),
      '23P01',
    );
    // La ruta a la misma hora que otro viaje no cancelado.
    await rejects((c) => insertTrip(c, { dep: `${day(10)}T13:00:00Z` }), '23505');

    await rejects(
      (c) => c.query(`UPDATE trips SET status = 'DEPARTED' WHERE id = $1`, [busy]),
      'P0001',
      'trips: no se pasa de PLANNED a DEPARTED',
    );
    await rejects(
      (c) => c.query(`UPDATE trips SET min_passengers = 5 WHERE id = $1`, [planned]),
      'P0001',
      'trips: la unidad, el plano y las horas quedan fijos desde la apertura de la venta',
    );
    await rejects(
      (c) =>
        c.query(
          `UPDATE trip_stops SET planned_arrival_at = planned_arrival_at WHERE trip_id = $1 AND seq = 1`,
          [planned],
        ),
      'P0001',
      'trip_stops: las paradas y el inventario solo cambian con el viaje planificado',
    );
    await rejects(
      (c) => c.query(`DELETE FROM trip_resources WHERE trip_id = $1`, [planned]),
      'P0001',
      'trip_resources: las paradas y el inventario solo cambian con el viaje planificado',
    );
    await rejects(
      (c) =>
        c.query(
          `DELETE FROM trip_pool_segment_usage WHERE pool_id IN (SELECT id FROM trip_capacity_pools WHERE trip_id = $1)`,
          [planned],
        ),
      'P0001',
      'trip_pool_segment_usage: solo se borran tramos sin ocupación al volver a planificar',
    );
    // A la venta sin sus contadores no se confirma; planificado con contadores, tampoco.
    await rejects(
      async (c) => {
        await c.query(
          `UPDATE trips SET status = 'PLANNED', opened_at = NULL, opened_by_kind = NULL, opened_by_id = NULL WHERE id = $1`,
          [planned],
        );
      },
      'P0001',
      'trips: un viaje planificado no tiene contadores por tramo',
      true,
    );
    // Un viaje planificado con inventario no recibe contadores.
    const fresh = await as(
      a,
      'post',
      '/api/v1/trips',
      trip({
        vehicleId: ids.lancha2,
        departureLocal: at(25, '08:00'),
        layout: { layoutId: ids.fastLayout, version: 1 },
      }),
    );
    expect(fresh.body.inventory.pools.length).toBeGreaterThan(0);
    await rejects(
      (c) =>
        c.query(
          `INSERT INTO trip_pool_segment_usage (tenant_id, pool_id, segment_seq, capacity)
         SELECT tenant_id, id, 0, capacity FROM trip_capacity_pools WHERE trip_id = $1`,
          [fresh.body.id],
        ),
      'P0001',
      'trip_pool_segment_usage: los tramos se materializan al abrir la venta',
    );
    // Cancelado es definitivo.
    const cancelled = list.find((t) => t.status === 'CANCELLED')?.id as string;
    await rejects(
      (c) => c.query(`UPDATE trips SET cancel_reason = 'Otro' WHERE id = $1`, [cancelled]),
      'P0001',
      'trips: un viaje cancelado no cambia',
    );
    // Privilegios.
    for (const sql of [
      `DELETE FROM trips WHERE id = $1`,
      `UPDATE trips SET route_id = route_id WHERE id = $1`,
      `UPDATE trips SET departure_kind = 'SCHEDULED' WHERE id = $1`,
      `DELETE FROM trip_stops WHERE trip_id = $1`,
      `UPDATE trip_stops SET location_id = location_id WHERE trip_id = $1`,
      `UPDATE trip_resources SET capacity = 1 WHERE trip_id = $1`,
      `UPDATE trip_pool_segment_usage SET used = 1 WHERE pool_id IN (SELECT id FROM trip_capacity_pools WHERE trip_id = $1)`,
    ]) {
      await rejects((c) => c.query(sql, [planned]), '42501');
    }
    // El CHECK del contador es la red final (el motor de la 7.4 moverá `used`).
    await expect(
      seed.query(
        `UPDATE trip_pool_segment_usage SET used = capacity + 1
          WHERE pool_id IN (SELECT id FROM trip_capacity_pools WHERE trip_id = $1)`,
        [planned],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'pool_within_capacity' });
  });

  it('aislamiento: otra empresa no ve ni usa los viajes, rutas ni unidades de esta (404 o 400), ni por RLS', async () => {
    expect((await as(b, 'get', `/api/v1/trips?from=${day(0)}&to=${day(40)}`)).body.trips).toEqual([]);
    expect((await as(b, 'get', `/api/v1/trips/${tripId}`)).status).toBe(404);
    expect((await as(b, 'get', `/api/v1/trips/${tripId}/inventory`)).status).toBe(404);
    expect((await as(b, 'post', `/api/v1/trips/${tripId}/open`)).status).toBe(404);
    expect((await as(b, 'post', `/api/v1/trips/${tripId}/cancel`, { reason: 'Ajena' })).status).toBe(404);
    expectError(
      await as(b, 'post', '/api/v1/trips', trip({ vehicleId: null })),
      400,
      'La ruta no es de la empresa',
    );
    expect((await as(a, 'get', '/api/v1/trips/no-es-un-id')).status).toBe(404);
    for (const table of [
      'trips',
      'trip_stops',
      'trip_resources',
      'trip_capacity_pools',
      'trip_pool_segment_usage',
    ]) {
      expect(
        await inTenant(b, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n),
      ).toBe(0);
    }
    const pool = testPool('app', DB, 1);
    try {
      expect((await pool.query('SELECT count(*)::int AS n FROM trips')).rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('permisos: sin trips.manage → 403; sin sesión → 401; NEW_COMMERCIAL en PAST_DUE sí, suspendida solo consulta', async () => {
    const userId = (
      await seed.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), 'cajera@viajes-a.pe', 'x', 'Cajera', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0]?.id as string;
    await seed.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [a.id, userId],
    );
    expect((await as(a, 'get', `/api/v1/trips/${tripId}`, undefined, userId)).status).toBe(403);
    expect(
      (
        await as(
          a,
          'post',
          '/api/v1/trips',
          trip({ vehicleId: null, departureLocal: at(60, '08:00') }),
          userId,
        )
      ).status,
    ).toBe(403);
    expect((await http().get(`/api/v1/trips/${tripId}`).set('Host', a.host)).status).toBe(401);

    const to = (status: string) =>
      asStaff('post', `/api/v1/platform/tenants/${a.id}/status`, { to: status, reason: 'Prueba 7.3a' });
    expect((await to('PAST_DUE')).status).toBe(200);
    try {
      const pastDue = await as(
        a,
        'post',
        '/api/v1/trips',
        trip({ vehicleId: null, departureLocal: at(60, '08:00') }),
      );
      expect(pastDue.status).toBe(201);
      expect((await to('SUSPENDED')).status).toBe(200);
      expect((await as(a, 'get', `/api/v1/trips/${pastDue.body.id}`)).status).toBe(200);
      expect(
        (await as(a, 'post', '/api/v1/trips', trip({ vehicleId: null, departureLocal: at(61, '08:00') })))
          .status,
      ).toBe(403);
      expect(
        (await as(a, 'post', `/api/v1/trips/${pastDue.body.id}/cancel`, { reason: 'Suspendida' })).status,
      ).toBe(403);
    } finally {
      expect((await to('ACTIVE')).status).toBe(200);
    }
  });
});
