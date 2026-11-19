/**
 * Fase 7.E1 · Equipamiento de unidades e inspecciones preoperacionales (plan-equipamiento-inspecciones; EQ-Q1–Q10).
 * PostgreSQL, Redis y almacenamiento reales:
 * - OPCIONAL: una empresa que no la usa opera igual (viaje, apertura, bloqueo) y no queda nada «pendiente»;
 * - catálogo de YEBO (sugerencias con referencia orientativa) y propio de la empresa; equipamiento por unidad;
 * - inspección que copia lo declarado, se marca, se completa con conteos y queda inmutable; la copia no cambia al
 *   editar la unidad; rectificación enlazada; historial por unidad y control preoperacional del viaje;
 * - fotos privadas sin metadatos; reglas de la base, aislamiento, permisos y estados del tenant.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { boatTemplate, busTemplate } from '@yebo/contracts';
import sharp from 'sharp';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { PERMISSION_CODES } from '../../src/modules/access/permission-catalog';
import { ObjectStorage } from '../../src/infrastructure/storage/object-storage';
import { SessionService } from '../../src/modules/identity/session.service';
import { RESET_TENANT_DATA, testBypassPool, testPool } from '../support/db';
import { STAFF_CSRF, seedPlatformSession } from '../support/platform-session';

const DB = 'yebo_test';
const ADMIN = 'admin.yebo.pe';
const HUB = 'cuentas.yebo.pe';
const CSRF = 'csrf-de-prueba-0123456789abcdef';
const PASSWORD = 'rios-claros-del-amazonas-2026';

type Company = { id: string; host: string; adminUserId: string };
type Method = 'get' | 'put' | 'post' | 'delete';

const PLACES = {
  pucallpa: { name: 'Pucallpa', kind: 'PORT', lat: -8.3791, lng: -74.5539 },
  contamana: { name: 'Contamana', kind: 'PORT', lat: -7.3352, lng: -75.0094 },
  yurimaguas: { name: 'Yurimaguas', kind: 'LANDING', lat: -5.8984, lng: -76.0911 },
  iquitos: { name: 'Iquitos', kind: 'CITY', lat: -3.7491, lng: -73.2472 },
  requena: { name: 'Requena', kind: 'LANDING', lat: null, lng: null },
} as const;
type Place = keyof typeof PLACES;

describe('Fase 7.E1 · equipamiento e inspecciones', () => {
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
      await seedPlatformSession(seed, { email: 'equipos@yebo.pe', role: 'SUPERADMIN', now: new Date() })
    ).cookie;
    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'equipos', name: 'Equipos' });
    const v = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
      basePrice: '99.00',
      billingInterval: 'MONTHLY',
      includedUsers: 5,
      extraUserPrice: '15.00',
      trialDays: 0,
      modules: ['PASSENGERS'],
    });
    await asStaff('post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
    a = await company('equipo-a', v.body.id);
    b = await company('equipo-b', v.body.id);
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
  const ids = { lancha: '', bus: '', boatLayout: '', busLayout: '', trip: '', busTrip: '' };
  const expectError = (res: request.Response, status: number, message?: string) => {
    expect([res.status, message === undefined ? undefined : res.body.error?.message]).toEqual([
      status,
      message,
    ]);
  };
  const item = (name: string, quantity: number, over: object = {}) => ({
    name,
    category: 'SAFETY',
    quantity,
    description: null,
    status: 'OPERATIVE',
    expiresOn: null,
    serialNumber: null,
    catalogCode: null,
    tenantItemId: null,
    ...over,
  });
  const inspect = (over: object = {}, c: Company = a, userId?: string) =>
    as(
      c,
      'post',
      '/api/v1/inspections',
      { vehicleId: ids.lancha, tripId: null, rectifiesId: null, rectificationReason: null, ...over },
      userId,
    );
  const mark = (id: string, itemId: string, result: string | null, over: object = {}) =>
    as(a, 'put', `/api/v1/inspections/${id}/items/${itemId}`, {
      result,
      foundQuantity: null,
      observation: null,
      ...over,
    });
  const byName = (items: { name: string; id: string }[], name: string) =>
    items.find((i) => i.name === name)?.id as string;
  const COMPLETED_MSG = 'La inspección ya está completada: para corregirla, crea una rectificación';

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
  it('opcional: una empresa que no declara equipamiento ni inspecciona opera igual, sin nada pendiente', async () => {
    const route = await as(a, 'post', '/api/v1/routes', {
      code: 'PCL-IQT',
      name: 'Pucallpa – Iquitos',
      modality: 'RIVER',
      stops: amazonas(),
    });
    routeId = route.body.id;
    ids.boatLayout = await layout('Lancha', 'RIVER', boatTemplate());
    ids.busLayout = await layout('Bus', 'LAND', busTemplate());
    ids.lancha = await vehicle('ODIN', 'RIVER', ids.boatLayout);
    ids.bus = await vehicle('BUS-01', 'LAND', ids.busLayout);
    // Viaje, apertura y bloqueo, como siempre: nada pide equipamiento ni inspección.
    const trip = await as(a, 'post', '/api/v1/trips', {
      routeId,
      departureLocal: at(3, '08:00'),
      vehicleId: ids.lancha,
      layout: null,
      minPassengers: null,
      confirmationDeadlineLocal: null,
    });
    expect(trip.status).toBe(201);
    ids.trip = trip.body.id;
    expect((await as(a, 'post', `/api/v1/trips/${ids.trip}/open`)).status).toBe(200);
    const blocked = await as(a, 'post', `/api/v1/trips/${ids.trip}/blocks`, {
      reason: 'CREW',
      note: null,
      fromSeq: 0,
      toSeq: 1,
      resourceCodes: ['1A'],
      pools: [],
      expiresAt: null,
    });
    expect(blocked.status).toBe(201);
    expect((await as(a, 'get', `/api/v1/vehicles/${ids.lancha}/equipment`)).body).toEqual({ equipment: [] });
    expect((await as(a, 'get', `/api/v1/vehicles/${ids.lancha}/inspections`)).body).toEqual({
      inspections: [],
    });
    const control = await as(a, 'get', `/api/v1/trips/${ids.trip}/inspections`);
    expect(control.body).toMatchObject({ tripId: ids.trip, inspections: [], latestForVehicle: null });
    expect(control.body.disclaimer).toBe(
      'Herramienta de control interno; no reemplaza las inspecciones ni certificaciones de la autoridad.',
    );
    // Inspeccionar exige algo que inspeccionar.
    expectError(
      await inspect(),
      400,
      'La unidad no tiene equipamiento declarado: decláralo antes de inspeccionarla',
    );
  });

  it('catálogo: sugerencias de YEBO por modalidad con referencia orientativa, y uno propio aislado por empresa', async () => {
    const cat = await as(a, 'get', '/api/v1/equipment-catalog');
    expect(cat.status).toBe(200);
    const yebo = cat.body.entries.filter((e: { source: string }) => e.source === 'CATALOG');
    expect(yebo).toHaveLength(16);
    expect(yebo.find((e: { ref: string }) => e.ref === 'CHALECO_SALVAVIDAS')).toMatchObject({
      name: 'Chalecos salvavidas',
      modality: 'RIVER',
      category: 'SAFETY',
      tracksExpiry: true,
    });
    expect(yebo.find((e: { ref: string }) => e.ref === 'BOTIQUIN')).toMatchObject({ modality: null });
    expect(yebo.find((e: { ref: string }) => e.ref === 'TRIANGULOS').modality).toBe('LAND');
    // Las referencias son orientativas: ninguna dice que sea obligatoria.
    for (const e of yebo.filter((x: { reference: string | null }) => x.reference)) {
      expect(e.reference).toMatch(/^Referencia orientativa/);
    }
    const custom = {
      name: 'Bote auxiliar',
      modality: 'RIVER',
      category: 'SAFETY',
      tracksExpiry: false,
      tracksSerial: true,
      description: 'Bote de rescate con remos',
    };
    const created = await as(a, 'post', '/api/v1/equipment-catalog', custom);
    expect(created.status).toBe(201);
    const mine = created.body.entries.find((e: { source: string }) => e.source === 'TENANT');
    expect(mine).toMatchObject({
      name: 'Bote auxiliar',
      modality: 'RIVER',
      archived: false,
      reference: null,
    });
    expectError(
      await as(a, 'post', '/api/v1/equipment-catalog', { ...custom, name: ' bote AUXILIAR ' }),
      409,
      'Ya hay un elemento activo con ese nombre en el catálogo de la empresa',
    );
    const archived = await as(a, 'post', `/api/v1/equipment-catalog/${mine.ref}/archive`);
    expect(archived.body.entries.find((e: { ref: string }) => e.ref === mine.ref).archived).toBe(true);
    expect((await as(a, 'post', '/api/v1/equipment-catalog', custom)).status).toBe(201);
    // La otra empresa no ve el catálogo propio de esta.
    const other = await as(b, 'get', '/api/v1/equipment-catalog');
    expect(other.body.entries.filter((e: { source: string }) => e.source === 'TENANT')).toEqual([]);
    expect((await as(b, 'post', `/api/v1/equipment-catalog/${mine.ref}/restore`)).status).toBe(404);
  });

  it('equipamiento de la unidad: declarar varios, editar, eliminar (archivar) y vencimientos', async () => {
    const tenantItem = (await as(a, 'get', '/api/v1/equipment-catalog')).body.entries.find(
      (e: { source: string; archived: boolean }) => e.source === 'TENANT' && !e.archived,
    ).ref;
    const added = await as(a, 'post', `/api/v1/vehicles/${ids.lancha}/equipment`, {
      items: [
        item('Chalecos salvavidas', 40, { catalogCode: 'CHALECO_SALVAVIDAS', expiresOn: day(10) }),
        item('Extintor PQS 6 kg', 2, {
          catalogCode: 'EXTINTOR',
          serialNumber: 'EXT-2231',
          expiresOn: day(200),
        }),
        item('Aros salvavidas', 4, { catalogCode: 'ARO_SALVAVIDAS' }),
        item('Botiquín', 1, { category: 'EMERGENCY', catalogCode: 'BOTIQUIN', expiresOn: day(-1) }),
        item('Radio VHF', 2, { category: 'OPERATION', catalogCode: 'RADIO', status: 'DETERIORATED' }),
        item('Bote auxiliar', 1, { tenantItemId: tenantItem, description: '  Con remos  ' }),
      ],
    });
    expect(added.status).toBe(201);
    const list = added.body.equipment as Record<string, unknown>[];
    expect(list.map((e) => [e.name, e.quantity, e.status, e.expiry])).toEqual([
      ['Aros salvavidas', 4, 'OPERATIVE', null],
      ['Bote auxiliar', 1, 'OPERATIVE', null],
      ['Chalecos salvavidas', 40, 'OPERATIVE', 'EXPIRING'],
      ['Extintor PQS 6 kg', 2, 'OPERATIVE', 'VALID'],
      ['Botiquín', 1, 'OPERATIVE', 'EXPIRED'],
      ['Radio VHF', 2, 'DETERIORATED', null],
    ]);
    expect(list.find((e) => e.name === 'Bote auxiliar')).toMatchObject({
      description: 'Con remos',
      tenantItemId: tenantItem,
    });
    // Validación: todo o nada.
    expectError(
      await as(a, 'post', `/api/v1/vehicles/${ids.lancha}/equipment`, {
        items: [item('Linterna', 2), item('Otro', 1, { catalogCode: 'NO_EXISTE' })],
      }),
      400,
      'Uno de los elementos no está en el catálogo de YEBO',
    );
    expect(
      (await as(a, 'post', `/api/v1/vehicles/${ids.lancha}/equipment`, { items: [item('Linterna', 0)] }))
        .status,
    ).toBe(400);
    expect(
      (
        await as(a, 'post', `/api/v1/vehicles/${ids.lancha}/equipment`, {
          items: [item('Linterna', 1, { catalogCode: 'LINTERNA', tenantItemId: tenantItem })],
        })
      ).status,
    ).toBe(400);
    expect((await as(a, 'post', `/api/v1/vehicles/${ids.lancha}/equipment`, { items: [] })).status).toBe(400);
    expect((await as(a, 'get', `/api/v1/vehicles/${ids.lancha}/equipment`)).body.equipment).toHaveLength(6);

    // Editar y eliminar (archivar).
    const radio = byName(list as never, 'Radio VHF');
    const edited = await as(a, 'put', `/api/v1/vehicles/${ids.lancha}/equipment/${radio}`, {
      ...item('Radio VHF marina', 2, { category: 'OPERATION', status: 'OPERATIVE', serialNumber: 'R-9' }),
      catalogCode: 'RADIO',
    });
    expect(edited.status).toBe(400); // el origen no se edita
    const ok = await as(a, 'put', `/api/v1/vehicles/${ids.lancha}/equipment/${radio}`, {
      name: 'Radio VHF marina',
      category: 'OPERATION',
      quantity: 2,
      description: null,
      status: 'OPERATIVE',
      expiresOn: null,
      serialNumber: 'R-9',
    });
    expect([ok.status, ok.body.name, ok.body.catalogCode]).toEqual([200, 'Radio VHF marina', 'RADIO']);
    const bote = byName(list as never, 'Bote auxiliar');
    expect(
      (await as(a, 'post', `/api/v1/vehicles/${ids.lancha}/equipment/${bote}/remove`)).body.archived,
    ).toBe(true);
    expectError(
      await as(a, 'post', `/api/v1/vehicles/${ids.lancha}/equipment/${bote}/remove`),
      409,
      'El elemento ya fue eliminado de la unidad',
    );
    expect((await as(a, 'get', `/api/v1/vehicles/${ids.lancha}/equipment`)).body.equipment).toHaveLength(5);
    expect(
      (await as(a, 'get', `/api/v1/vehicles/${ids.lancha}/equipment?archived=true`)).body.equipment,
    ).toHaveLength(6);
  });

  let first = '';
  it('inspección: copia lo declarado, se marca y se completa con conteos; completada es inmutable y su copia no cambia', async () => {
    const draft = await inspect({ tripId: ids.trip });
    expect(draft.status).toBe(201);
    first = draft.body.id;
    expect(draft.body).toMatchObject({
      vehicleCode: 'ODIN',
      vehicleRegistration: 'ODIN-2026',
      trip: { id: ids.trip },
      status: 'DRAFT',
      counts: null,
      completedAt: null,
      startedBy: { kind: 'MEMBERSHIP', name: 'Gerencia General' },
      generalNotes: null,
      rectifiesId: null,
      rectifiedBy: [],
    });
    const items = draft.body.items as { id: string; name: string; declaredQuantity: number }[];
    expect(items.map((i) => [i.name, i.declaredQuantity])).toEqual([
      ['Aros salvavidas', 4],
      ['Chalecos salvavidas', 40],
      ['Extintor PQS 6 kg', 2],
      ['Botiquín', 1],
      ['Radio VHF marina', 2],
    ]);
    expectError(
      await as(a, 'post', `/api/v1/inspections/${first}/complete`),
      400,
      'Falta marcar 5 elementos para completar la inspección',
    );
    await mark(first, byName(items, 'Chalecos salvavidas'), 'OBSERVED', {
      foundQuantity: 38,
      observation: 'Faltan 2 chalecos',
    });
    await mark(first, byName(items, 'Radio VHF marina'), 'NOT_OPERATIONAL', { observation: 'Sin batería' });
    for (const n of ['Aros salvavidas', 'Extintor PQS 6 kg', 'Botiquín'])
      await mark(first, byName(items, n), 'CONFORMING');
    expect(
      (await as(a, 'put', `/api/v1/inspections/${first}`, { generalNotes: 'Revisión antes del zarpe' }))
        .status,
    ).toBe(200);
    const done = await as(a, 'post', `/api/v1/inspections/${first}/complete`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      status: 'COMPLETED_WITH_OBSERVATIONS',
      counts: { conforming: 3, observed: 1, notOperational: 1, notAvailable: 0 },
      completedBy: { kind: 'MEMBERSHIP', name: 'Gerencia General' },
      generalNotes: 'Revisión antes del zarpe',
    });
    expect(done.body.items.find((i: { name: string }) => i.name === 'Chalecos salvavidas')).toMatchObject({
      result: 'OBSERVED',
      foundQuantity: 38,
      observation: 'Faltan 2 chalecos',
    });
    // Completada: nada cambia ni se borra.
    expectError(await mark(first, items[0]?.id as string, 'OBSERVED'), 409, COMPLETED_MSG);
    expectError(
      await as(a, 'put', `/api/v1/inspections/${first}`, { generalNotes: 'Otra' }),
      409,
      COMPLETED_MSG,
    );
    expectError(await as(a, 'post', `/api/v1/inspections/${first}/complete`), 409, COMPLETED_MSG);
    expectError(await as(a, 'delete', `/api/v1/inspections/${first}`), 409, COMPLETED_MSG);

    // Editar o eliminar el equipamiento de la unidad no cambia la inspección anterior.
    const equipment = (await as(a, 'get', `/api/v1/vehicles/${ids.lancha}/equipment`)).body.equipment;
    const chalecos = byName(equipment, 'Chalecos salvavidas');
    await as(a, 'put', `/api/v1/vehicles/${ids.lancha}/equipment/${chalecos}`, {
      name: 'Chalecos salvavidas adulto',
      category: 'SAFETY',
      quantity: 50,
      description: null,
      status: 'OPERATIVE',
      expiresOn: null,
      serialNumber: null,
    });
    await as(a, 'post', `/api/v1/vehicles/${ids.lancha}/equipment/${byName(equipment, 'Botiquín')}/remove`);
    const again = (await as(a, 'get', `/api/v1/inspections/${first}`)).body;
    expect(
      again.items.map((i: { name: string; declaredQuantity: number }) => [i.name, i.declaredQuantity]),
    ).toEqual(items.map((i) => [i.name, i.declaredQuantity]));

    // Una segunda, sin viaje, toda conforme.
    const second = await inspect();
    for (const it of second.body.items) await mark(second.body.id, it.id, 'CONFORMING');
    const ok = await as(a, 'post', `/api/v1/inspections/${second.body.id}/complete`);
    expect([ok.body.status, ok.body.counts, ok.body.trip]).toEqual([
      'COMPLETED',
      { conforming: 4, observed: 0, notOperational: 0, notAvailable: 0 },
      null,
    ]);
    expect(ok.body.items.map((i: { name: string }) => i.name)).toEqual([
      'Aros salvavidas',
      'Chalecos salvavidas adulto',
      'Extintor PQS 6 kg',
      'Radio VHF marina',
    ]);

    // Historial de la unidad y control preoperacional del viaje.
    const history = (await as(a, 'get', `/api/v1/vehicles/${ids.lancha}/inspections`)).body.inspections;
    expect(history.map((h: { id: string; status: string }) => [h.id, h.status])).toEqual([
      [second.body.id, 'COMPLETED'],
      [first, 'COMPLETED_WITH_OBSERVATIONS'],
    ]);
    const control = (await as(a, 'get', `/api/v1/trips/${ids.trip}/inspections`)).body;
    expect(control.inspections.map((i: { id: string }) => i.id)).toEqual([first]);
    expect(control.latestForVehicle.id).toBe(second.body.id);
  });

  it('rectificación: una inspección nueva enlazada que copia los elementos de la original, que queda intacta', async () => {
    expect((await inspect({ rectifiesId: first, rectificationReason: null })).status).toBe(400);
    const rect = await inspect({
      rectifiesId: first,
      rectificationReason: ' Se encontraron los 2 chalecos ',
    });
    expect(rect.status).toBe(201);
    expect(rect.body).toMatchObject({
      rectifiesId: first,
      rectificationReason: 'Se encontraron los 2 chalecos',
      trip: { id: ids.trip },
    });
    // Copia lo verificado en aquel momento, no el equipamiento actual.
    expect(
      rect.body.items.map((i: { name: string; declaredQuantity: number }) => [i.name, i.declaredQuantity]),
    ).toEqual([
      ['Aros salvavidas', 4],
      ['Chalecos salvavidas', 40],
      ['Extintor PQS 6 kg', 2],
      ['Botiquín', 1],
      ['Radio VHF marina', 2],
    ]);
    // Antes de completarse, la original no figura como rectificada.
    expect((await as(a, 'get', `/api/v1/inspections/${first}`)).body.rectifiedBy).toEqual([]);
    for (const it of rect.body.items) {
      await mark(rect.body.id, it.id, it.name === 'Radio VHF marina' ? 'NOT_OPERATIONAL' : 'CONFORMING');
    }
    expect((await as(a, 'post', `/api/v1/inspections/${rect.body.id}/complete`)).body.status).toBe(
      'COMPLETED_WITH_OBSERVATIONS',
    );
    const original = (await as(a, 'get', `/api/v1/inspections/${first}`)).body;
    expect(original).toMatchObject({ rectifiedBy: [rect.body.id], status: 'COMPLETED_WITH_OBSERVATIONS' });
    expect(original.counts).toEqual({ conforming: 3, observed: 1, notOperational: 1, notAvailable: 0 });
    // Solo se rectifica una completada de la misma unidad.
    const draft = await inspect();
    expectError(
      await inspect({ rectifiesId: draft.body.id, rectificationReason: 'Prueba' }),
      400,
      'Solo se rectifica una inspección completada de la misma unidad',
    );
    expect((await as(a, 'delete', `/api/v1/inspections/${draft.body.id}`)).status).toBe(204);
    expect((await as(a, 'get', `/api/v1/inspections/${draft.body.id}`)).status).toBe(404);
  });

  it('fotos: privadas, recodificadas sin metadatos, con límites y solo en borrador', async () => {
    const draft = await inspect();
    const itemId = draft.body.items[0].id as string;
    const withExif = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#2a6f4f' } })
      .withMetadata({ exif: { IFD0: { Copyright: 'yebo' } } })
      .jpeg()
      .toBuffer();
    const upload = (body: Buffer, item?: string, type = 'image/jpeg') =>
      http()
        .post(`/api/v1/inspections/${draft.body.id}/photos${item ? `?itemId=${item}` : ''}`)
        .set('Host', a.host)
        .set('X-CSRF-Token', CSRF)
        .set('Content-Type', type)
        .send(body);
    const auth = async (r: request.Test) => r.set('Cookie', await cookie(a));
    const up = await auth(upload(withExif, itemId));
    expect(up.status).toBe(201);
    expect(up.body.photos).toHaveLength(1);
    expect(up.body.photos[0].itemId).toBe(itemId);
    const photoId = up.body.photos[0].id as string;
    const got = await http()
      .get(`/api/v1/inspections/${draft.body.id}/photos/${photoId}`)
      .set('Host', a.host)
      .set('Cookie', await cookie(a))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(got.headers['cache-control']).toBe('private, no-store');
    expect((await sharp(got.body as Buffer).metadata()).exif).toBeUndefined();
    // Una general, un archivo que no es imagen y un elemento ajeno.
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    expect((await auth(upload(png, undefined, 'image/png'))).body.photos).toHaveLength(2);
    expectError(
      await auth(upload(Buffer.from('no es una imagen'))),
      400,
      'La foto debe ser un JPEG, PNG o WebP válido',
    );
    expectError(await auth(upload(png, first, 'image/png')), 400, 'El elemento no es de esta inspección');
    // Quitar una foto borra su archivo.
    const key = (
      await seed.query<{ k: string }>(
        `SELECT f.storage_key AS k FROM vehicle_inspection_evidence e JOIN file_assets f ON f.id = e.file_asset_id
          WHERE e.id = $1`,
        [photoId],
      )
    ).rows[0]?.k as string;
    expect(
      (await as(a, 'delete', `/api/v1/inspections/${draft.body.id}/photos/${photoId}`)).body.photos,
    ).toHaveLength(1);
    expect(await app.get(ObjectStorage).get(key)).toBeNull();
    // Completada: ya no recibe fotos. Descartar un borrador borra sus fotos.
    for (const it of draft.body.items) await mark(draft.body.id, it.id, 'CONFORMING');
    await as(a, 'post', `/api/v1/inspections/${draft.body.id}/complete`);
    expectError(await auth(upload(png, undefined, 'image/png')), 409, COMPLETED_MSG);
    const other = await inspect();
    const otherUp = await auth(
      http()
        .post(`/api/v1/inspections/${other.body.id}/photos`)
        .set('Host', a.host)
        .set('X-CSRF-Token', CSRF)
        .set('Content-Type', 'image/png')
        .send(png),
    );
    const otherKey = (
      await seed.query<{ k: string }>(
        'SELECT storage_key AS k FROM file_assets WHERE id = (SELECT file_asset_id FROM vehicle_inspection_evidence WHERE id = $1)',
        [otherUp.body.photos[0].id],
      )
    ).rows[0]?.k as string;
    expect((await as(a, 'delete', `/api/v1/inspections/${other.body.id}`)).status).toBe(204);
    expect(await app.get(ObjectStorage).get(otherKey)).toBeNull();
  });

  it('viaje de otra unidad, viaje cancelado y unidad retirada', async () => {
    const busRoute = await as(a, 'post', '/api/v1/routes', {
      code: 'CTM-YMS',
      name: 'Contamana – Yurimaguas',
      modality: 'RIVER',
      stops: [stop('contamana', 0), stop('yurimaguas', 600)],
    });
    const other = await as(a, 'post', '/api/v1/trips', {
      routeId: busRoute.body.id,
      departureLocal: at(20, '08:00'),
      vehicleId: null,
      layout: null,
      minPassengers: null,
      confirmationDeadlineLocal: null,
    });
    expectError(await inspect({ tripId: other.body.id }), 400, 'El viaje no es de esa unidad');
    expectError(
      await inspect({ tripId: '0190f0a0-0000-7000-8000-000000000999' }),
      400,
      'El viaje no es de la empresa',
    );
    const cancelled = await as(a, 'post', '/api/v1/trips', {
      routeId: busRoute.body.id,
      departureLocal: at(25, '08:00'),
      vehicleId: ids.lancha,
      layout: null,
      minPassengers: null,
      confirmationDeadlineLocal: null,
    });
    await as(a, 'post', `/api/v1/trips/${cancelled.body.id}/cancel`, { reason: 'Prueba' });
    expectError(await inspect({ tripId: cancelled.body.id }), 400, 'El viaje está cancelado');
    const retired = await vehicle('VIEJA', 'RIVER', null);
    await as(a, 'post', `/api/v1/vehicles/${retired}/equipment`, { items: [item('Aros salvavidas', 2)] });
    await as(a, 'put', `/api/v1/vehicles/${retired}`, update('VIEJA', types.RIVER as string, 'RETIRED'));
    expectError(await inspect({ vehicleId: retired }), 409, 'La unidad VIEJA está retirada');
  });

  it('reglas de la base: completada inmutable, viaje de la misma unidad, conteos exactos, CHECK y privilegios', async () => {
    const rejects = (fn: (c: PoolClient) => Promise<unknown>, code: string, message?: string) =>
      expect(inTenant(a, fn)).rejects.toMatchObject(message ? { code, message } : { code });
    await rejects(
      (c) => c.query(`UPDATE vehicle_inspections SET general_notes = 'x' WHERE id = $1`, [first]),
      'P0001',
      'vehicle_inspections: una inspección completada no cambia',
    );
    await rejects(
      (c) => c.query(`DELETE FROM vehicle_inspections WHERE id = $1`, [first]),
      'P0001',
      'vehicle_inspections: una inspección completada no se borra',
    );
    await rejects(
      (c) =>
        c.query(`UPDATE vehicle_inspection_items SET result = 'OBSERVED' WHERE inspection_id = $1`, [first]),
      'P0001',
      'vehicle_inspection_items: una inspección completada no cambia',
    );
    const draft = (await inspect()).body;
    await rejects(
      (c) =>
        c.query(
          `UPDATE vehicle_inspections SET status = 'COMPLETED', completed_at = now(), completed_by_kind = 'MEMBERSHIP',
                  completed_by_id = started_by_id, conforming_count = 0, observed_count = 0,
                  not_operational_count = 0, not_available_count = 0 WHERE id = $1`,
          [draft.id],
        ),
      'P0001',
      'vehicle_inspections: para completar, cada elemento tiene su resultado',
    );
    await rejects(
      async (c) => {
        await c.query(`UPDATE vehicle_inspection_items SET result = 'CONFORMING' WHERE inspection_id = $1`, [
          draft.id,
        ]);
        await c.query(
          `UPDATE vehicle_inspections SET status = 'COMPLETED', completed_at = now(), completed_by_kind = 'MEMBERSHIP',
                  completed_by_id = started_by_id, conforming_count = 1, observed_count = 0,
                  not_operational_count = 0, not_available_count = 0 WHERE id = $1`,
          [draft.id],
        );
      },
      'P0001',
      'vehicle_inspections: los conteos y el resultado general no coinciden con los elementos',
    );
    const busTrip = await as(a, 'post', '/api/v1/trips', {
      routeId,
      departureLocal: at(40, '08:00'),
      vehicleId: null,
      layout: null,
      minPassengers: null,
      confirmationDeadlineLocal: null,
    });
    await rejects(
      (c) =>
        c.query(
          `INSERT INTO vehicle_inspections (id, tenant_id, vehicle_id, trip_id, vehicle_code, vehicle_name,
                                            vehicle_registration, started_by_kind, started_by_id)
           VALUES (gen_random_uuid(), $1, $2, $3, 'X', 'X', 'X', 'MEMBERSHIP', gen_random_uuid())`,
          [a.id, ids.lancha, busTrip.body.id],
        ),
      'P0001',
      'vehicle_inspections: el viaje no es de esa unidad',
    );
    const anyEquipment = (await as(a, 'get', `/api/v1/vehicles/${ids.lancha}/equipment`)).body.equipment[0]
      .id;
    for (const [sql, code] of [
      [`UPDATE vehicle_equipment SET quantity = 0 WHERE id = $1`, '23514'],
      [`UPDATE vehicle_equipment SET vehicle_id = vehicle_id WHERE id = $1`, '42501'],
      [`DELETE FROM vehicle_equipment WHERE id = $1`, '42501'],
    ] as const) {
      await rejects((c) => c.query(sql, [anyEquipment]), code);
    }
    for (const sql of [
      `UPDATE vehicle_inspections SET vehicle_id = vehicle_id WHERE id = $1`,
      `UPDATE vehicle_inspection_items SET name = 'Otro' WHERE inspection_id = $1`,
      `INSERT INTO equipment_catalog (code, name, category, tracks_expiry, tracks_serial, sort_order)
       SELECT 'NUEVO', 'Nuevo', 'SAFETY', false, false, 1 WHERE $1::uuid IS NOT NULL`,
    ]) {
      await rejects((c) => c.query(sql, [draft.id]), '42501');
    }
    // Las fotos de evidencia son privadas (regla del tipo de archivo).
    await expect(
      seed.query(
        `INSERT INTO file_assets (id, tenant_id, kind, visibility, status, storage_key, mime, size_bytes, width, height,
                                  checksum_sha256, uploaded_by_kind, uploaded_by_id)
         VALUES (gen_random_uuid(), $1::uuid, 'INSPECTION_EVIDENCE', 'PUBLIC', 'READY', 'tenants/' || $1::text || '/x.jpg',
                 'image/jpeg', 10, 1, 1, decode(repeat('ab', 32), 'hex'), 'MEMBERSHIP', gen_random_uuid())`,
        [a.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'file_assets_kind_rules' });
  });

  it('aislamiento: otra empresa no ve ni toca el equipamiento ni las inspecciones de esta (404), ni por RLS', async () => {
    expect((await as(b, 'get', `/api/v1/vehicles/${ids.lancha}/equipment`)).status).toBe(404);
    expect((await as(b, 'get', `/api/v1/vehicles/${ids.lancha}/inspections`)).status).toBe(404);
    expect((await as(b, 'get', `/api/v1/inspections/${first}`)).status).toBe(404);
    expect((await as(b, 'get', `/api/v1/trips/${ids.trip}/inspections`)).status).toBe(404);
    expect(
      (await as(b, 'post', `/api/v1/vehicles/${ids.lancha}/equipment`, { items: [item('Ajeno', 1)] })).status,
    ).toBe(404);
    expectError(await inspect({}, b), 400, 'La unidad no es de la empresa');
    expect((await as(b, 'delete', `/api/v1/inspections/${first}`)).status).toBe(404);
    for (const table of [
      'tenant_equipment_items',
      'vehicle_equipment',
      'vehicle_inspections',
      'vehicle_inspection_items',
      'vehicle_inspection_evidence',
    ]) {
      expect(
        await inTenant(b, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n),
      ).toBe(0);
    }
    const pool = testPool('app', DB, 1);
    try {
      expect((await pool.query('SELECT count(*)::int AS n FROM vehicle_inspections')).rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('permisos: sin los permisos → 403; sin sesión → 401; suspendida inspecciona (FULFILL) pero no declara (CONFIGURE)', async () => {
    const userId = (
      await seed.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), 'cajera@equipo-a.pe', 'x', 'Cajera', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0]?.id as string;
    await seed.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [a.id, userId],
    );
    expect((await as(a, 'get', `/api/v1/vehicles/${ids.lancha}/inspections`, undefined, userId)).status).toBe(
      403,
    );
    expect((await as(a, 'get', '/api/v1/equipment-catalog', undefined, userId)).status).toBe(403);
    expect((await inspect({}, a, userId)).status).toBe(403);
    expect((await http().get(`/api/v1/inspections/${first}`).set('Host', a.host)).status).toBe(401);
    const to = (status: string) =>
      asStaff('post', `/api/v1/platform/tenants/${a.id}/status`, { to: status, reason: 'Prueba 7.E1' });
    expect((await to('PAST_DUE')).status).toBe(200);
    expect((await to('SUSPENDED')).status).toBe(200);
    try {
      const draft = await inspect();
      expect(draft.status).toBe(201);
      for (const it of draft.body.items) await mark(draft.body.id, it.id, 'CONFORMING');
      expect((await as(a, 'post', `/api/v1/inspections/${draft.body.id}/complete`)).status).toBe(200);
      expect(
        (await as(a, 'post', `/api/v1/vehicles/${ids.lancha}/equipment`, { items: [item('Linterna', 1)] }))
          .status,
      ).toBe(403);
      expect((await as(a, 'get', `/api/v1/vehicles/${ids.lancha}/equipment`)).status).toBe(200);
    } finally {
      expect((await to('ACTIVE')).status).toBe(200);
    }
  });
});
