/**
 * Criterio de aceptación de la Fase 6 (plan, etapa 6.6): «una lancha con camarotes (con camas), zona libre, bodega y
 * cubierta, y un bus con asientos y bodega, se construyen por la API de la empresa, se publican, se asignan a sus
 * vehículos y su capacidad derivada es la esperada». A pedido del responsable, el bus es de dos pisos y se suma una
 * camioneta pickup 4×4 de la selva: asientos en la cabina y, en la tolva, pasajeros más baratos y carga.
 *
 * Parte de la API, en la CI: una empresa real (fluvial con pasajeros, encomiendas y carga; terrestre con pasajeros y
 * carga), con su administradora registrada desde la invitación, construye los tres planos pieza a pieza como lo hace
 * el editor: plano en blanco, pisos y zonas, luego camarotes o asientos con los generadores de contratos, y el aforo.
 * Publica, crea sus vehículos y les asigna cada plano. Se comprueba la capacidad derivada que devuelve la API (números
 * esperados, escritos a mano) y que lo materializado en la base al publicar (zonas, elementos vendibles y reglas de
 * capacidad) es exactamente eso: lo que la Fase 7 copiará a cada viaje. La mitad del editor está en el E2E
 * 10-criterio-fase6.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { deriveInventory, emptyLayout, type DerivedInventory, type LayoutDocument } from '@yebo/contracts';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { PERMISSION_CODES } from '../../src/modules/access/permission-catalog';
import { SessionService } from '../../src/modules/identity/session.service';
import { bus, busFloors, lancha, lanchaFloors, pickup, pickupFloors } from '../support/criterion-layouts';
import { RESET_TENANT_DATA, testBypassPool, testPool } from '../support/db';
import { STAFF_CSRF, seedPlatformSession } from '../support/platform-session';

const DB = 'yebo_test';
const ADMIN = 'admin.yebo.pe';
const HUB = 'cuentas.yebo.pe';
const CSRF = 'csrf-de-prueba-0123456789abcdef';
const PASSWORD = 'rios-claros-del-amazonas-2026';

type Company = { id: string; host: string; adminUserId: string };
type Method = 'get' | 'put' | 'post';

const day = (offset: number) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
};

const DOCS = { lancha, bus, pickup } as const;

/** Lo que cada plano debe dar: escrito a mano, no calculado con deriveInventory. */
const EXPECTED = {
  lancha: {
    summary: {
      seats: 0,
      beds: 6,
      cabins: 3,
      vehicleSlots: 0,
      assignedPersons: 6,
      pooledPersons: 30,
      totalPersons: 36,
    },
    pools: [
      { scope: 'ZONE', zoneCode: 'LIBRE', dimension: 'PERSONS', capacity: 30 },
      { scope: 'ZONE', zoneCode: 'CARGA', dimension: 'WEIGHT_KG', capacity: 5000 },
      { scope: 'ZONE', zoneCode: 'CARGA', dimension: 'LINEAR_M', capacity: 10 },
      { scope: 'ZONE', zoneCode: 'BODEGA', dimension: 'WEIGHT_KG', capacity: 2000 },
      { scope: 'ZONE', zoneCode: 'BODEGA', dimension: 'VOLUME_M3', capacity: 10 },
      { scope: 'VEHICLE', zoneCode: null, dimension: 'PERSONS', capacity: 36 },
    ],
    // Se venden las 6 camas (CAMA), o cada camarote completo (CAMAROTE), nunca el camarote como recurso suelto.
    sellable: ['C1-B1', 'C1-B2', 'C2-B1', 'C2-B2', 'C3-B1', 'C3-B2'],
    wholeCabins: ['C1', 'C2', 'C3'],
  },
  bus: {
    summary: {
      seats: 56,
      beds: 0,
      cabins: 0,
      vehicleSlots: 0,
      assignedPersons: 56,
      pooledPersons: 0,
      totalPersons: 56,
    },
    pools: [
      { scope: 'ZONE', zoneCode: 'EQUIPAJE', dimension: 'WEIGHT_KG', capacity: 1500 },
      { scope: 'ZONE', zoneCode: 'EQUIPAJE', dimension: 'VOLUME_M3', capacity: 8 },
      { scope: 'VEHICLE', zoneCode: null, dimension: 'PERSONS', capacity: 56 },
    ],
    sellable: Array.from({ length: 14 }, (_, r) => ['A', 'B', 'C', 'D'].map((l) => `${r + 1}${l}`)).flat(),
    wholeCabins: [] as string[],
  },
  pickup: {
    summary: {
      seats: 4,
      beds: 0,
      cabins: 0,
      vehicleSlots: 0,
      assignedPersons: 4,
      pooledPersons: 4,
      totalPersons: 8,
    },
    pools: [
      { scope: 'ZONE', zoneCode: 'TOLVA', dimension: 'PERSONS', capacity: 4 },
      { scope: 'ZONE', zoneCode: 'CARGA', dimension: 'WEIGHT_KG', capacity: 600 },
      { scope: 'VEHICLE', zoneCode: null, dimension: 'PERSONS', capacity: 8 },
    ],
    sellable: ['S1', 'S2', 'S3', 'S4'],
    wholeCabins: [] as string[],
  },
} as const;
const DECKS = { lancha: 2, bus: 3, pickup: 1 } as const;

describe('Fase 6 · criterio de aceptación: lancha y bus construidos, publicados, asignados y con su capacidad', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let staff = '';
  let empresa: Company;

  const http = () => request(app.getHttpServer());
  const asStaff = (method: 'get' | 'post', path: string, body?: object) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', staff);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  const as = async (method: Method, path: string, body?: object) => {
    const sessions = app.get(SessionService);
    const identity = (
      await sessions.createIdentitySession({ userId: empresa.adminUserId, authMethods: ['pwd'] })
    ).id;
    const token = (await sessions.openTenantSession({ identitySessionId: identity, host: empresa.host }))
      .accessToken;
    const agent = http();
    let req = agent[method](path)
      .set('Host', empresa.host)
      .set('Cookie', `__Host-yebo_at=${token}; __Host-yebo_csrf=${CSRF}`);
    if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
    return body ? req.send(body) : req;
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
      await seedPlatformSession(seed, { email: 'criterio6@yebo.pe', role: 'SUPERADMIN', now: new Date() })
    ).cookie;

    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'flota', name: 'Flota' });
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
      slug: 'amazonas-y-carretera',
      legalName: 'Amazonas y Carretera SAC',
      tradeName: 'Amazonas y Carretera',
      taxIdType: 'RUC',
      taxId: `20${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      planVersionId: v.body.id,
      services: [
        { modality: 'RIVER', service: 'PASSENGER' },
        { modality: 'RIVER', service: 'PARCEL' },
        { modality: 'RIVER', service: 'CARGO' },
        { modality: 'LAND', service: 'PASSENGER' },
        { modality: 'LAND', service: 'CARGO' },
      ],
      firstAdminEmail: 'flota@amazonas-y-carretera.pe',
    });
    expect(created.status).toBe(201);
    const link = created.body.firstAdminInvitation.link as string;
    const reg = await http()
      .post('/api/v1/hub/invitations/register')
      .set('Host', HUB)
      .set('Cookie', `__Host-yebo_csrf=${CSRF}`)
      .set('X-CSRF-Token', CSRF)
      .send({ token: link.split('#')[1], fullName: 'Jefatura de Flota', password: PASSWORD });
    expect(reg.status).toBe(200);
    const userId = (
      await seed.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
        'flota@amazonas-y-carretera.pe',
      ])
    ).rows[0]?.id as string;
    empresa = { id: created.body.id, host: created.body.primaryHost, adminUserId: userId };
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  const built: Record<keyof typeof DOCS, { layoutId: string; vehicleId: string }> = {
    lancha: { layoutId: '', vehicleId: '' },
    bus: { layoutId: '', vehicleId: '' },
    pickup: { layoutId: '', vehicleId: '' },
  };

  /** Plano en blanco → pisos y zonas → elementos y aforo → publicar, como en el editor. */
  const build = async (
    name: string,
    modality: 'RIVER' | 'LAND',
    floors: LayoutDocument,
    full: LayoutDocument,
  ) => {
    const created = await as('post', '/api/v1/layouts', {
      name,
      modality,
      vehicleTypeId: null,
      document: null,
    });
    expect(created.status).toBe(201);
    expect(created.body.document).toEqual(emptyLayout(modality));
    const id = created.body.layoutId as string;

    // Con las zonas y sin elementos se guarda, pero aún no se puede publicar.
    const half = await as('put', `/api/v1/layouts/${id}/draft`, { document: floors });
    expect(half.status).toBe(200);
    expect(half.body.issues.length).toBeGreaterThan(0);
    expect((await as('post', `/api/v1/layouts/${id}/publish`)).status).toBe(400);

    const done = await as('put', `/api/v1/layouts/${id}/draft`, { document: full });
    expect(done.status).toBe(200);
    expect(done.body.issues).toEqual([]);
    const published = await as('post', `/api/v1/layouts/${id}/publish`);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ version: 1, status: 'PUBLISHED', issues: [] });
    return id;
  };

  it('la empresa construye y publica la lancha, el bus y la pickup por su API', async () => {
    built.lancha.layoutId = await build('Lancha Amazonas', 'RIVER', lanchaFloors, lancha);
    built.bus.layoutId = await build('Bus dos pisos', 'LAND', busFloors, bus);
    built.pickup.layoutId = await build('Pickup 4×4', 'LAND', pickupFloors, pickup);
  });

  it('crea sus vehículos y les asigna cada plano publicado desde hoy', async () => {
    // La pickup, desde la sugerencia nueva del catálogo global.
    const catalog = (await as('get', '/api/v1/vehicle-types')).body.catalog as {
      code: string;
      name: string;
    }[];
    expect(catalog.filter((c) => ['VAN', 'PICKUP'].includes(c.code))).toEqual([
      { code: 'VAN', name: 'Van', modality: 'LAND' },
      { code: 'PICKUP', name: 'Camioneta pickup 4×4', modality: 'LAND' },
    ]);
    for (const [key, modality, typeName, code, catalogCode] of [
      ['lancha', 'RIVER', 'Lancha de pasajeros y carga', 'LANCHA-01', null],
      ['bus', 'LAND', 'Bus interprovincial', 'BUS-01', 'BUS'],
      ['pickup', 'LAND', 'Camioneta pickup 4×4', 'PICKUP-01', 'PICKUP'],
    ] as const) {
      const type = await as('post', '/api/v1/vehicle-types', { name: typeName, modality, catalogCode });
      expect(type.status).toBe(201);
      const vehicle = await as('post', '/api/v1/vehicles', {
        code,
        name: code,
        vehicleTypeId: type.body.id,
        registration: `${code}-2026`,
        status: 'ACTIVE',
        ownership: 'OWN',
        nominalCapacity: { passengers: null, weightKg: null, volumeM3: null },
        features: [],
      });
      expect(vehicle.status).toBe(201);
      built[key].vehicleId = vehicle.body.id;
      const assigned = await as('post', `/api/v1/vehicles/${vehicle.body.id}/layout-assignments`, {
        layoutId: built[key].layoutId,
        version: 1,
        validFrom: day(0),
        validTo: null,
      });
      expect(assigned.status).toBe(201);
    }
    // Una lancha no recibe el plano del bus (y al revés): cada uno, en su modalidad.
    expect(
      (
        await as('post', `/api/v1/vehicles/${built.bus.vehicleId}/layout-assignments`, {
          layoutId: built.lancha.layoutId,
          version: 1,
          validFrom: day(30),
          validTo: null,
        })
      ).status,
    ).toBe(400);
  });

  for (const key of ['lancha', 'bus', 'pickup'] as const) {
    it(`${key}: la capacidad derivada del plano vigente del vehículo es la esperada`, async () => {
      const expected = EXPECTED[key];
      // Desde el vehículo: su asignación vigente → la versión publicada → su inventario.
      const assignments = (await as('get', `/api/v1/vehicles/${built[key].vehicleId}/layout-assignments`))
        .body.assignments as {
        layoutId: string;
        version: number;
        validFrom: string;
        validTo: string | null;
      }[];
      expect(assignments).toHaveLength(1);
      const current = assignments[0]!;
      expect(current).toMatchObject({
        layoutId: built[key].layoutId,
        version: 1,
        validFrom: day(0),
        validTo: null,
      });
      const detail = await as('get', `/api/v1/layouts/${current.layoutId}/versions/${current.version}`);
      expect(detail.status).toBe(200);
      expect(detail.body.status).toBe('PUBLISHED');
      const inventory = detail.body.inventory as DerivedInventory;

      expect(inventory.summary).toEqual(expected.summary);
      expect(inventory.pools).toEqual(expected.pools);
      expect(inventory.resources.filter((r) => r.isSellable).map((r) => r.code)).toEqual(expected.sellable);
      expect(inventory.resources.filter((r) => r.sellableAsUnit).map((r) => r.code)).toEqual(
        expected.wholeCabins,
      );
      // La API usa la misma derivación que el editor muestra antes de publicar.
      expect(inventory).toEqual(deriveInventory(DOCS[key]));
    });

    it(`${key}: lo materializado en la base al publicar es exactamente esa capacidad`, async () => {
      const expected = EXPECTED[key];
      const { rows: version } = await seed.query<{ id: string; total: number; decks: number }>(
        `SELECT v.id, v.total_persons AS total, v.decks
           FROM vehicle_layout_assignments a JOIN layout_versions v ON v.id = a.layout_version_id
          WHERE a.vehicle_id = $1 AND a.valid_from <= $2::date AND (a.valid_to IS NULL OR a.valid_to > $2::date)`,
        [built[key].vehicleId, day(0)],
      );
      expect(version).toHaveLength(1);
      const v = version[0]!;
      expect(v.total).toBe(expected.summary.totalPersons);
      expect(v.decks).toBe(DECKS[key]);

      const { rows: sellable } = await seed.query<{ code: string }>(
        `SELECT code FROM layout_elements WHERE layout_version_id = $1 AND is_assignable`,
        [v.id],
      );
      expect(sellable.map((r) => r.code).sort()).toEqual([...expected.sellable].sort());
      const { rows: whole } = await seed.query<{ code: string; capacity: number }>(
        `SELECT code, capacity FROM layout_elements WHERE layout_version_id = $1 AND sellable_as_unit ORDER BY code`,
        [v.id],
      );
      expect(whole).toEqual(expected.wholeCabins.map((code) => ({ code, capacity: 2 })));

      const { rows: rules } = await seed.query<{ zone: string; dimension: string; capacity: string }>(
        `SELECT z.code AS zone, r.dimension::text AS dimension, r.capacity::text AS capacity
           FROM capacity_rules r JOIN layout_zones z ON z.id = r.zone_id
          WHERE z.layout_version_id = $1`,
        [v.id],
      );
      const byKey = (a: { zone: string | null; dimension: string }, b: typeof a) =>
        `${a.zone} ${a.dimension}` < `${b.zone} ${b.dimension}` ? -1 : 1;
      const zonePools = expected.pools
        .filter((p) => p.scope === 'ZONE')
        .map((p) => ({ zone: p.zoneCode, dimension: p.dimension, capacity: p.capacity.toFixed(3) }));
      expect([...rules].sort(byKey)).toEqual([...zonePools].sort(byKey));
    });
  }

  it('pickup: la cabina y la tolva se venden con clases de precio distintas', async () => {
    const detail = await as('get', `/api/v1/layouts/${built.pickup.layoutId}/versions/1`);
    const inventory = detail.body.inventory as DerivedInventory;
    expect(inventory.resources.map((r) => [r.code, r.priceClassCode])).toEqual([
      ['S1', 'CABINA'],
      ['S2', 'CABINA'],
      ['S3', 'CABINA'],
      ['S4', 'CABINA'],
    ]);
    const { rows } = await seed.query<{ code: string; kind: string; service: string; price: string | null }>(
      `SELECT z.code, z.kind::text AS kind, z.service::text AS service, z.price_class_code AS price
         FROM layout_zones z JOIN layout_versions v ON v.id = z.layout_version_id
        WHERE v.layout_id = $1 AND v.version = 1 ORDER BY z.code`,
      [built.pickup.layoutId],
    );
    expect(rows).toEqual([
      { code: 'CABINA', kind: 'SEATING', service: 'PASSENGER', price: null },
      { code: 'CARGA', kind: 'CARGO_DECK', service: 'CARGO', price: null },
      { code: 'TOLVA', kind: 'FREE_ZONE', service: 'PASSENGER', price: 'TOLVA' },
    ]);
    const { rows: seats } = await seed.query<{ code: string; price: string | null }>(
      `SELECT e.code, e.price_class_code AS price
         FROM layout_elements e JOIN layout_versions v ON v.id = e.layout_version_id
        WHERE v.layout_id = $1 AND v.version = 1 AND e.is_assignable ORDER BY e.code`,
      [built.pickup.layoutId],
    );
    expect(seats).toEqual(['S1', 'S2', 'S3', 'S4'].map((code) => ({ code, price: 'CABINA' })));
  });

  it('la versión asignada ya no cambia: un borrador nuevo no toca la capacidad del vehículo', async () => {
    const draft = await as('put', `/api/v1/layouts/${built.bus.layoutId}/draft`, {
      document: { ...bus, totalPersons: 54 },
    });
    expect(draft.body).toMatchObject({ version: 2, status: 'DRAFT' });
    const detail = await as('get', `/api/v1/layouts/${built.bus.layoutId}/versions/1`);
    expect(detail.body.inventory.summary).toEqual(EXPECTED.bus.summary);
  });
});
