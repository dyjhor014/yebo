/**
 * Criterio de aceptación de la Fase 7 (plan, etapa 7.7): «ruta multiparada con capacidad correcta por tramo».
 *
 * Por la API de la empresa, en la CI: la lancha de la 6.6 (camarotes con camas, zona libre, cubierta de carga y
 * bodega) en la ruta fluvial Pucallpa → Contamana → Yurimaguas → Iquitos, y el bus de dos pisos de la 6.6 en la ruta
 * terrestre Pucallpa → Aguaytía → Tingo María. Se crean los viajes, se abren a la venta y se ocupan con bloqueos en
 * tramos superpuestos y contiguos. La disponibilidad de cada recurso y de cada cupo, tramo por tramo, es la esperada:
 * las cifras están escritas a mano, no se calculan. Lo que no cabe se rechaza con el tramo exacto y no deja nada a
 * medias; liberar devuelve la capacidad. La mitad de las pantallas está en el E2E 15-criterio-fase7.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { LayoutDocument } from '@yebo/contracts';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { PERMISSION_CODES } from '../../src/modules/access/permission-catalog';
import { SessionService } from '../../src/modules/identity/session.service';
import { bus, lancha } from '../support/criterion-layouts';
import { RESET_TENANT_DATA, testBypassPool, testPool } from '../support/db';
import { STAFF_CSRF, seedPlatformSession } from '../support/platform-session';

const DB = 'yebo_test';
const ADMIN = 'admin.yebo.pe';
const HUB = 'cuentas.yebo.pe';
const CSRF = 'csrf-de-prueba-0123456789abcdef';
const PASSWORD = 'rios-claros-del-amazonas-2026';

type Method = 'get' | 'put' | 'post';
type Trip = { id: string; pools: Record<string, string> };
type Availability = {
  segments: { seq: number; from: string; to: string }[];
  resources: { code: string; kind: string; zoneCode: string; free: boolean[] }[];
  pools: {
    id: string;
    zoneCode: string | null;
    dimension: string;
    capacity: number;
    used: number[];
    free: number[];
  }[];
};

const day = (offset: number) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
};

const PLACES = {
  pucallpa: { name: 'Puerto Pucallpa', kind: 'PORT', lat: -8.3791, lng: -74.5539 },
  contamana: { name: 'Contamana', kind: 'PORT', lat: -7.3352, lng: -75.0094 },
  yurimaguas: { name: 'Yurimaguas', kind: 'LANDING', lat: -5.8984, lng: -76.0911 },
  iquitos: { name: 'Iquitos', kind: 'PORT', lat: -3.7491, lng: -73.2472 },
  terminal: { name: 'Terminal Pucallpa', kind: 'TERMINAL', lat: -8.3929, lng: -74.5826 },
  aguaytia: { name: 'Aguaytía', kind: 'TERMINAL', lat: -9.0367, lng: -75.5089 },
  tingo: { name: 'Tingo María', kind: 'TERMINAL', lat: -9.2953, lng: -75.9975 },
} as const;
type Place = keyof typeof PLACES;

describe('Fase 7 · criterio de aceptación: ruta multiparada con capacidad correcta por tramo', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let staff = '';
  let host = '';
  let adminUserId = '';
  const loc = {} as Record<Place, string>;
  const vehicle = { lancha: '', bus: '' };
  const route = { rio: '', carretera: '' };
  let rio: Trip;
  let carretera: Trip;

  const http = () => request(app.getHttpServer());
  const asStaff = (method: 'get' | 'post', path: string, body?: object) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', staff);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  const as = async (method: Method, path: string, body?: object) => {
    const sessions = app.get(SessionService);
    const identity = (await sessions.createIdentitySession({ userId: adminUserId, authMethods: ['pwd'] })).id;
    const token = (await sessions.openTenantSession({ identitySessionId: identity, host })).accessToken;
    const agent = http();
    let req = agent[method](path)
      .set('Host', host)
      .set('Cookie', `__Host-yebo_at=${token}; __Host-yebo_csrf=${CSRF}`);
    if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
    return body ? req.send(body) : req;
  };
  const ok = async (method: Method, path: string, body?: object, status = 201) => {
    const res = await as(method, path, body);
    if (res.status !== status) throw new Error(`${path} → ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };

  const availability = async (trip: Trip): Promise<Availability> =>
    ok('get', `/api/v1/trips/${trip.id}/availability`, undefined, 200);
  const block = (trip: Trip, fromSeq: number, toSeq: number, over: object) =>
    as('post', `/api/v1/trips/${trip.id}/blocks`, {
      reason: 'CREW',
      note: null,
      fromSeq,
      toSeq,
      resourceCodes: [],
      pools: [],
      expiresAt: null,
      ...over,
    });
  const blockOk = async (trip: Trip, fromSeq: number, toSeq: number, over: object) => {
    const res = await block(trip, fromSeq, toSeq, over);
    if (res.status !== 201) throw new Error(`bloqueo → ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body as { id: string; resourceCodes: string[] };
  };
  const rejected = async (res: request.Response, code: string, message: string) => {
    expect([res.status, res.body.error?.code, res.body.error?.message]).toEqual([409, code, message]);
  };
  /** Libre tramo por tramo de varios recursos. */
  const freeOf = (a: Availability, codes: string[]) =>
    Object.fromEntries(codes.map((c) => [c, a.resources.find((r) => r.code === c)?.free]));
  /** Ocupado y libre de un cupo, por su clave `ZONA:DIMENSIÓN` (o `UNIDAD:PERSONS`). */
  const poolOf = (a: Availability, trip: Trip, key: string) => {
    const p = a.pools.find((x) => x.id === trip.pools[key]);
    return { capacity: p?.capacity, used: p?.used, free: p?.free };
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
      await seedPlatformSession(seed, { email: 'criterio7@yebo.pe', role: 'SUPERADMIN', now: new Date() })
    ).cookie;

    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'rutas', name: 'Rutas' });
    const v = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
      basePrice: '99.00',
      billingInterval: 'MONTHLY',
      includedUsers: 5,
      extraUserPrice: '15.00',
      trialDays: 0,
      modules: ['PASSENGERS'],
    });
    await asStaff('post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
    const created = await asStaff('post', '/api/v1/platform/tenants', {
      slug: 'rios-y-carreteras',
      legalName: 'Ríos y Carreteras SAC',
      tradeName: 'Ríos y Carreteras',
      taxIdType: 'RUC',
      taxId: `20${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      planVersionId: v.body.id,
      services: [
        { modality: 'RIVER', service: 'PASSENGER' },
        { modality: 'RIVER', service: 'PARCEL' },
        { modality: 'RIVER', service: 'CARGO' },
        { modality: 'LAND', service: 'PASSENGER' },
      ],
      firstAdminEmail: 'operaciones@rios-y-carreteras.pe',
    });
    expect(created.status).toBe(201);
    const link = created.body.firstAdminInvitation.link as string;
    const reg = await http()
      .post('/api/v1/hub/invitations/register')
      .set('Host', HUB)
      .set('Cookie', `__Host-yebo_csrf=${CSRF}`)
      .set('X-CSRF-Token', CSRF)
      .send({ token: link.split('#')[1], fullName: 'Operaciones', password: PASSWORD });
    expect(reg.status).toBe(200);
    adminUserId = (
      await seed.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
        'operaciones@rios-y-carreteras.pe',
      ])
    ).rows[0]?.id as string;
    host = created.body.primaryHost as string;
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  it('la empresa publica la lancha y el bus de la 6.6, los asigna y arma sus dos rutas', async () => {
    for (const [key, place] of Object.entries(PLACES) as [Place, (typeof PLACES)[Place]][]) {
      loc[key] = (await ok('post', '/api/v1/locations', { ...place, ubigeo: null, region: null })).id;
    }
    const units: [keyof typeof vehicle, 'RIVER' | 'LAND', LayoutDocument, string][] = [
      ['lancha', 'RIVER', lancha, 'LANCHA-01'],
      ['bus', 'LAND', bus, 'BUS-2P'],
    ];
    for (const [key, modality, document, code] of units) {
      const layout = await ok('post', '/api/v1/layouts', {
        name: code,
        modality,
        vehicleTypeId: null,
        document,
      });
      await ok('post', `/api/v1/layouts/${layout.layoutId}/publish`, undefined, 200);
      const type = await ok('post', '/api/v1/vehicle-types', {
        name: `Tipo ${code}`,
        modality,
        catalogCode: null,
      });
      vehicle[key] = (
        await ok('post', '/api/v1/vehicles', {
          code,
          name: code,
          vehicleTypeId: type.id,
          registration: `${code}-PE`,
          status: 'ACTIVE',
          ownership: 'OWN',
          nominalCapacity: { passengers: null, weightKg: null, volumeM3: null },
          features: [],
        })
      ).id;
      await ok('post', `/api/v1/vehicles/${vehicle[key]}/layout-assignments`, {
        layoutId: layout.layoutId,
        version: 1,
        validFrom: day(0),
        validTo: null,
      });
    }

    const stop = (place: Place, offsetMinutes: number, boarding = true, alighting = true) => ({
      locationId: loc[place],
      offsetMinutes,
      dwellMinutes: 0,
      allowsBoarding: boarding,
      allowsAlighting: alighting,
      pathToNext: null,
    });
    route.rio = (
      await ok('post', '/api/v1/routes', {
        code: 'PCL-IQT',
        name: 'Pucallpa – Iquitos',
        modality: 'RIVER',
        stops: [
          stop('pucallpa', 0, true, false),
          stop('contamana', 12 * 60),
          stop('yurimaguas', 36 * 60),
          stop('iquitos', 84 * 60, false, true),
        ],
      })
    ).id;
    route.carretera = (
      await ok('post', '/api/v1/routes', {
        code: 'PCL-TGM',
        name: 'Pucallpa – Tingo María',
        modality: 'LAND',
        stops: [stop('terminal', 0, true, false), stop('aguaytia', 180), stop('tingo', 360, false, true)],
      })
    ).id;
  });

  it('cada viaje copia su plano al crearse y se abre a la venta con un contador por cupo y tramo', async () => {
    const open = async (routeId: string, vehicleId: string, time: string): Promise<Trip> => {
      const trip = await ok('post', '/api/v1/trips', {
        routeId,
        departureLocal: `${day(1)}T${time}`,
        vehicleId,
        layout: null,
        minPassengers: null,
        confirmationDeadlineLocal: null,
      });
      const opened = await ok('post', `/api/v1/trips/${trip.id}/open`, undefined, 200);
      expect(opened.status).toBe('OPEN_FOR_SALE');
      const pools: Record<string, string> = {};
      for (const p of opened.inventory.pools as {
        id: string;
        zoneCode: string | null;
        dimension: string;
      }[]) {
        pools[`${p.zoneCode ?? 'UNIDAD'}:${p.dimension}`] = p.id;
      }
      return { id: trip.id, pools };
    };
    rio = await open(route.rio, vehicle.lancha, '08:00');
    carretera = await open(route.carretera, vehicle.bus, '07:00');

    const inv = async (t: Trip) => (await ok('get', `/api/v1/trips/${t.id}`, undefined, 200)).inventory;
    // Lancha: 3 camarotes y 6 camas materializados; se venden las 6 camas. 6 cupos × 3 tramos.
    expect(await inv(rio)).toMatchObject({ resources: 9, sellableResources: 6, segmentRows: 18 });
    expect(Object.keys(rio.pools).sort()).toEqual(
      [
        'BODEGA:VOLUME_M3',
        'BODEGA:WEIGHT_KG',
        'CARGA:LINEAR_M',
        'CARGA:WEIGHT_KG',
        'LIBRE:PERSONS',
        'UNIDAD:PERSONS',
      ].sort(),
    );
    // Bus: 56 asientos en dos pisos. 3 cupos × 2 tramos.
    expect(await inv(carretera)).toMatchObject({ resources: 56, sellableResources: 56, segmentRows: 6 });
    expect(Object.keys(carretera.pools).sort()).toEqual(
      ['EQUIPAJE:VOLUME_M3', 'EQUIPAJE:WEIGHT_KG', 'UNIDAD:PERSONS'].sort(),
    );

    const a = await availability(rio);
    expect(a.segments).toEqual([
      { seq: 0, from: 'Puerto Pucallpa', to: 'Contamana' },
      { seq: 1, from: 'Contamana', to: 'Yurimaguas' },
      { seq: 2, from: 'Yurimaguas', to: 'Iquitos' },
    ]);
    expect(a.resources.every((r) => r.free.length === 3 && r.free.every(Boolean))).toBe(true);
    const b = await availability(carretera);
    expect(b.segments).toEqual([
      { seq: 0, from: 'Terminal Pucallpa', to: 'Aguaytía' },
      { seq: 1, from: 'Aguaytía', to: 'Tingo María' },
    ]);
  });

  it('lancha: camas y camarotes en tramos superpuestos y contiguos', async () => {
    // Camarote C1 completo de Pucallpa a Yurimaguas: ocupa sus dos camas en los tramos 0 y 1.
    expect((await blockOk(rio, 0, 2, { resourceCodes: ['C1'] })).resourceCodes).toEqual(['C1-B1', 'C1-B2']);
    // Contiguo: la cama C1-B1 de Yurimaguas a Iquitos (empieza donde terminó el anterior).
    await blockOk(rio, 2, 3, { resourceCodes: ['C1-B1'] });
    // Superpuesto con otro recurso: C2-B1 de Contamana a Iquitos.
    await blockOk(rio, 1, 3, { resourceCodes: ['C2-B1'] });
    // Superpuesto con el mismo recurso: se rechaza con el tramo exacto.
    await rejected(
      await block(rio, 1, 2, { resourceCodes: ['C1-B2'] }),
      'RESOURCE_UNAVAILABLE',
      'Ocupado entre Contamana y Yurimaguas: C1-B2',
    );
    // El camarote C2 completo ya no se puede de Pucallpa a Iquitos (una de sus camas está ocupada). El mensaje nombra
    // el tramo exacto donde choca, no todo lo pedido.
    await rejected(
      await block(rio, 0, 3, { resourceCodes: ['C2'] }),
      'RESOURCE_UNAVAILABLE',
      'Ocupado entre Contamana y Iquitos: C2-B1',
    );

    // Libre en cada tramo: [Pucallpa–Contamana, Contamana–Yurimaguas, Yurimaguas–Iquitos].
    expect(
      freeOf(await availability(rio), [
        'C1',
        'C1-B1',
        'C1-B2',
        'C2',
        'C2-B1',
        'C2-B2',
        'C3',
        'C3-B1',
        'C3-B2',
      ]),
    ).toEqual({
      C1: [false, false, false],
      'C1-B1': [false, false, false],
      'C1-B2': [false, false, true],
      C2: [true, false, false],
      'C2-B1': [true, false, false],
      'C2-B2': [true, true, true],
      C3: [true, true, true],
      'C3-B1': [true, true, true],
      'C3-B2': [true, true, true],
    });
  });

  it('lancha: zona libre, cubierta de carga, bodega y aforo, tramo por tramo; liberar devuelve la capacidad', async () => {
    const libre = rio.pools['LIBRE:PERSONS'] as string;
    // Zona libre (30 personas): 10 todo el viaje, 20 solo entre Contamana y Yurimaguas, y 20 en el último tramo.
    await blockOk(rio, 0, 3, { pools: [{ poolId: libre, quantity: 10 }] });
    const middle = await blockOk(rio, 1, 2, { pools: [{ poolId: libre, quantity: 20 }] });
    await rejected(
      await block(rio, 1, 2, { pools: [{ poolId: libre, quantity: 1 }] }),
      'CAPACITY_EXCEEDED',
      'La zona LIBRE (personas) sin capacidad entre Contamana y Yurimaguas',
    );
    await blockOk(rio, 2, 3, { pools: [{ poolId: libre, quantity: 20 }] });

    // Cubierta de carga (5000 kg y 10 m lineales): 4000 kg y 6 m hasta Yurimaguas; 1000 kg de Contamana a Iquitos.
    await blockOk(rio, 0, 2, {
      reason: 'OTHER',
      note: 'Carga de la naviera',
      pools: [
        { poolId: rio.pools['CARGA:WEIGHT_KG'], quantity: 4000 },
        { poolId: rio.pools['CARGA:LINEAR_M'], quantity: 6 },
      ],
    });
    await blockOk(rio, 1, 3, {
      reason: 'OTHER',
      note: 'Carga',
      pools: [{ poolId: rio.pools['CARGA:WEIGHT_KG'], quantity: 1000 }],
    });
    // Bodega (2000 kg y 10 m³): llena en el último tramo. Un bloqueo que excede en un tramo no ocupa ninguno.
    await rejected(
      await block(rio, 1, 3, {
        reason: 'OTHER',
        note: 'Encomiendas',
        pools: [
          { poolId: rio.pools['BODEGA:WEIGHT_KG'], quantity: 100 },
          { poolId: rio.pools['CARGA:WEIGHT_KG'], quantity: 1 },
        ],
      }),
      'CAPACITY_EXCEEDED',
      'La zona CARGA (kg) sin capacidad entre Contamana y Yurimaguas',
    );
    await blockOk(rio, 2, 3, {
      reason: 'OTHER',
      note: 'Encomiendas',
      pools: [
        { poolId: rio.pools['BODEGA:WEIGHT_KG'], quantity: 2000 },
        { poolId: rio.pools['BODEGA:VOLUME_M3'], quantity: 10 },
      ],
    });
    // Aforo de la unidad (36): 6 de tripulación todo el viaje.
    await blockOk(rio, 0, 3, { pools: [{ poolId: rio.pools['UNIDAD:PERSONS'], quantity: 6 }] });

    let a = await availability(rio);
    expect(poolOf(a, rio, 'LIBRE:PERSONS')).toEqual({ capacity: 30, used: [10, 30, 30], free: [20, 0, 0] });
    expect(poolOf(a, rio, 'CARGA:WEIGHT_KG')).toEqual({
      capacity: 5000,
      used: [4000, 5000, 1000],
      free: [1000, 0, 4000],
    });
    expect(poolOf(a, rio, 'CARGA:LINEAR_M')).toEqual({ capacity: 10, used: [6, 6, 0], free: [4, 4, 10] });
    expect(poolOf(a, rio, 'BODEGA:WEIGHT_KG')).toEqual({
      capacity: 2000,
      used: [0, 0, 2000],
      free: [2000, 2000, 0],
    });
    expect(poolOf(a, rio, 'BODEGA:VOLUME_M3')).toEqual({ capacity: 10, used: [0, 0, 10], free: [10, 10, 0] });
    expect(poolOf(a, rio, 'UNIDAD:PERSONS')).toEqual({ capacity: 36, used: [6, 6, 6], free: [30, 30, 30] });

    // Liberar los 20 del tramo del medio: vuelven a caber, y solo ahí.
    expect(
      (await ok('post', `/api/v1/trips/${rio.id}/blocks/${middle.id}/release`, undefined, 200)).state,
    ).toBe('RELEASED');
    await blockOk(rio, 1, 2, { pools: [{ poolId: libre, quantity: 1 }] });
    a = await availability(rio);
    expect(poolOf(a, rio, 'LIBRE:PERSONS')).toEqual({ capacity: 30, used: [10, 11, 30], free: [20, 19, 0] });
  });

  it('bus de dos pisos: asientos de los dos pisos, bodega de equipaje y aforo, tramo por tramo', async () => {
    // Asientos del piso 1 y del piso 2, superpuestos y contiguos.
    await blockOk(carretera, 0, 1, { resourceCodes: ['1A', '1B'] });
    await blockOk(carretera, 1, 2, { resourceCodes: ['1A'] });
    await blockOk(carretera, 0, 2, { resourceCodes: ['5A'] });
    await blockOk(carretera, 1, 2, { resourceCodes: ['14D'] });
    await rejected(
      await block(carretera, 1, 2, { resourceCodes: ['2A', '5A'] }),
      'RESOURCE_UNAVAILABLE',
      'Ocupado entre Aguaytía y Tingo María: 5A',
    );
    // Varios lugares que chocan en tramos distintos: cada uno con el suyo, y no se ocupa ninguno (2A sigue libre).
    await rejected(
      await block(carretera, 0, 2, { resourceCodes: ['14D', '1B', '2A', '5A'] }),
      'RESOURCE_UNAVAILABLE',
      'Ocupados entre Terminal Pucallpa y Aguaytía: 1B; entre Terminal Pucallpa y Tingo María: 5A; entre Aguaytía y Tingo María: 14D',
    );
    // Bodega de equipaje (1500 kg y 8 m³).
    await blockOk(carretera, 0, 2, {
      reason: 'OTHER',
      note: 'Equipaje',
      pools: [
        { poolId: carretera.pools['EQUIPAJE:WEIGHT_KG'], quantity: 1000 },
        { poolId: carretera.pools['EQUIPAJE:VOLUME_M3'], quantity: 5 },
      ],
    });
    await blockOk(carretera, 1, 2, {
      reason: 'OTHER',
      note: 'Equipaje',
      pools: [{ poolId: carretera.pools['EQUIPAJE:WEIGHT_KG'], quantity: 500 }],
    });
    await rejected(
      await block(carretera, 0, 2, {
        reason: 'OTHER',
        note: 'Equipaje',
        pools: [{ poolId: carretera.pools['EQUIPAJE:WEIGHT_KG'], quantity: 1 }],
      }),
      'CAPACITY_EXCEEDED',
      'La zona EQUIPAJE (kg) sin capacidad entre Aguaytía y Tingo María',
    );
    // Aforo (56): completo en el primer tramo.
    await blockOk(carretera, 0, 1, { pools: [{ poolId: carretera.pools['UNIDAD:PERSONS'], quantity: 56 }] });
    await rejected(
      await block(carretera, 0, 2, { pools: [{ poolId: carretera.pools['UNIDAD:PERSONS'], quantity: 1 }] }),
      'CAPACITY_EXCEEDED',
      'El aforo de la unidad sin capacidad entre Terminal Pucallpa y Aguaytía',
    );

    const a = await availability(carretera);
    expect(freeOf(a, ['1A', '1B', '2A', '4D', '5A', '14D'])).toEqual({
      '1A': [false, false],
      '1B': [false, true],
      '2A': [true, true],
      '4D': [true, true],
      '5A': [false, false],
      '14D': [true, false],
    });
    // Asientos libres por tramo: 56 menos 3 en cada uno (1A, 1B y 5A; luego 1A, 5A y 14D).
    expect([0, 1].map((s) => a.resources.filter((r) => r.free[s]).length)).toEqual([53, 53]);
    expect(poolOf(a, carretera, 'EQUIPAJE:WEIGHT_KG')).toEqual({
      capacity: 1500,
      used: [1000, 1500],
      free: [500, 0],
    });
    expect(poolOf(a, carretera, 'EQUIPAJE:VOLUME_M3')).toEqual({ capacity: 8, used: [5, 5], free: [3, 3] });
    expect(poolOf(a, carretera, 'UNIDAD:PERSONS')).toEqual({ capacity: 56, used: [56, 0], free: [0, 56] });
  });

  it('lo rechazado no dejó nada a medias: los contadores de la base cuadran con los bloqueos activos', async () => {
    // Reconciliación (§6.8): por cada cupo y tramo, el contador es la suma de las asignaciones activas.
    // Con el rol que salta RLS (con el del dueño, RLS no deja ver filas y la consulta pasaría en vacío).
    const { rows } = await seed.query<{ segments: number; mismatches: number }>(
      `SELECT count(*)::int AS segments, count(*) FILTER (WHERE u.used <> x.expected)::int AS mismatches
         FROM trip_pool_segment_usage u
         JOIN trip_capacity_pools p ON p.id = u.pool_id
         CROSS JOIN LATERAL (
           SELECT coalesce(sum(a.quantity), 0) AS expected FROM pool_allocations a
            WHERE a.pool_id = u.pool_id AND a.status <> 'RELEASED' AND a.stop_range @> u.segment_seq) x
        WHERE p.trip_id = ANY($1::uuid[])`,
      [[rio.id, carretera.id]],
    );
    // 6 cupos × 3 tramos en la lancha y 3 × 2 en el bus: 24 contadores revisados, ninguno descuadrado.
    expect(rows[0]).toEqual({ segments: 24, mismatches: 0 });
    // Solo existen los bloqueos aceptados: 11 en la lancha (uno liberado) y 7 en el bus; ninguno de los rechazados.
    const blocks = await seed.query<{ trip_id: string; total: number; active: number }>(
      `SELECT trip_id::text, count(*)::int AS total, count(*) FILTER (WHERE released_at IS NULL)::int AS active
         FROM trip_blocks WHERE trip_id = ANY($1::uuid[]) GROUP BY trip_id`,
      [[rio.id, carretera.id]],
    );
    const by = Object.fromEntries(blocks.rows.map((r) => [r.trip_id, [r.total, r.active]]));
    expect([by[rio.id], by[carretera.id]]).toEqual([
      [11, 10],
      [7, 7],
    ]);
  });
});
