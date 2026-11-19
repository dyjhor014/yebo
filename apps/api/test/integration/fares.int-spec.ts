/**
 * Fase 7.2 · Tarifas (data-dictionary §5; F7-Q1; ADR-010). PostgreSQL y Redis reales: tarifas por par de la ruta,
 * servicio y clase, con vigencia [desde, hasta) en el calendario de la empresa; cambio de precio (la anterior termina
 * ese día), sin solapamientos, consulta por fecha, matriz con las clases de los planos asignados y lo que falta,
 * terminar y anular, pares que dejan de ser de la ruta, reglas de la base (EXCLUDE, CHECK, privilegios y trigger),
 * aislamiento entre empresas (RLS), permisos y estados del tenant.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { boatTemplate } from '@yebo/contracts';
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

describe('Fase 7.2 · tarifas', () => {
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
      await seedPlatformSession(seed, { email: 'tarifas@yebo.pe', role: 'SUPERADMIN', now: new Date() })
    ).cookie;
    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'tarifas', name: 'Tarifas' });
    const v = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
      basePrice: '99.00',
      billingInterval: 'MONTHLY',
      includedUsers: 5,
      extraUserPrice: '15.00',
      trialDays: 0,
      modules: ['PASSENGERS'],
    });
    await asStaff('post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
    a = await company('tarifas-a', v.body.id);
    b = await company('tarifas-b', v.body.id);
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
  const dmy = (offset: number) => day(offset).split('-').reverse().join('/');

  let routeId = '';
  const fares = (path = '') => `/api/v1/routes/${routeId}/fares${path}`;
  const item = (origin: Place, destination: Place, priceClassCode: string, amount: string) => ({
    originLocationId: loc[origin],
    destinationLocationId: loc[destination],
    priceClassCode,
    amount,
  });
  const create = (c: Company, body: object, route = routeId) =>
    as(c, 'post', `/api/v1/routes/${route}/fares`, { service: 'PASSENGER', validTo: null, ...body });
  const quote = (c: Company, origin: Place, destination: Place, priceClass: string, date?: string) =>
    as(
      c,
      'get',
      fares(
        `/quote?origin=${loc[origin]}&destination=${loc[destination]}&priceClass=${priceClass}` +
          (date ? `&date=${date}` : ''),
      ),
    );
  const summary = (f: Record<string, unknown>) => [
    f.originName,
    f.destinationName,
    f.priceClassCode,
    f.amount,
    f.validFrom,
    f.validTo,
    f.phase,
  ];

  it('crear y consultar: tarifas por par y clase, montos en soles y precio de A a B en una fecha', async () => {
    const route = await as(a, 'post', '/api/v1/routes', {
      code: 'PCL-IQT',
      name: 'Pucallpa – Iquitos',
      modality: 'RIVER',
      stops: amazonas(),
    });
    expect(route.status).toBe(201);
    routeId = route.body.id;

    const created = await create(a, {
      validFrom: day(0),
      items: [
        item('pucallpa', 'iquitos', 'general', '120'),
        item('pucallpa', 'contamana', 'GENERAL', ' 35.5 '),
        item('contamana', 'iquitos', 'GENERAL', '95.00'),
        item('pucallpa', 'iquitos', 'CAMA', '180.00'),
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.ended).toEqual([]);
    expect(created.body.fares.map(summary)).toEqual([
      ['Pucallpa', 'Iquitos', 'GENERAL', '120.00', day(0), null, 'CURRENT'],
      ['Pucallpa', 'Contamana', 'GENERAL', '35.50', day(0), null, 'CURRENT'],
      ['Contamana', 'Iquitos', 'GENERAL', '95.00', day(0), null, 'CURRENT'],
      ['Pucallpa', 'Iquitos', 'CAMA', '180.00', day(0), null, 'CURRENT'],
    ]);
    expect(created.body.fares[0]).toMatchObject({
      routeId,
      service: 'PASSENGER',
      currency: 'PEN',
      status: 'ACTIVE',
      onRoute: true,
    });

    // Precio de A a B en la clase X en la fecha F (sin fecha, hoy).
    const today = await quote(a, 'pucallpa', 'iquitos', 'general');
    expect([today.status, today.body.amount, today.body.priceClassCode]).toEqual([200, '120.00', 'GENERAL']);
    expect((await quote(a, 'pucallpa', 'iquitos', 'CAMA', day(400))).body.amount).toBe('180.00');
    const before = await quote(a, 'pucallpa', 'iquitos', 'GENERAL', day(-1));
    expect([before.status, before.body.error.message]).toEqual([
      404,
      `No hay tarifa GENERAL de pasajeros para ese tramo el ${dmy(-1)}`,
    ]);
    expect((await quote(a, 'pucallpa', 'yurimaguas', 'GENERAL')).status).toBe(404);
    // El sentido de la ruta: de Iquitos no se sube y no se vuelve a Pucallpa.
    const back = await quote(a, 'iquitos', 'pucallpa', 'GENERAL');
    expect([back.status, back.body.error.message]).toEqual([
      400,
      'En esta ruta no se viaja de ese origen a ese destino',
    ]);
    expect((await as(a, 'get', fares('/quote?origin=x&destination=y&priceClass=GENERAL'))).status).toBe(400);

    // La lista sigue el orden de los pares de la ruta.
    const list = await as(a, 'get', fares());
    expect(list.status).toBe(200);
    expect(
      list.body.fares.map(
        (f: Record<string, unknown>) => f.originName + '→' + f.destinationName + ' ' + f.priceClassCode,
      ),
    ).toEqual([
      'Pucallpa→Contamana GENERAL',
      'Pucallpa→Iquitos CAMA',
      'Pucallpa→Iquitos GENERAL',
      'Contamana→Iquitos GENERAL',
    ]);
  });

  it('cambio de precio: la tarifa anterior termina el día que empieza la nueva; los solapamientos restantes son 409', async () => {
    const changed = await create(a, {
      validFrom: day(10),
      items: [item('pucallpa', 'iquitos', 'GENERAL', '130.00')],
    });
    expect(changed.status).toBe(201);
    expect(changed.body.fares.map(summary)).toEqual([
      ['Pucallpa', 'Iquitos', 'GENERAL', '130.00', day(10), null, 'SCHEDULED'],
    ]);
    expect(changed.body.ended.map(summary)).toEqual([
      ['Pucallpa', 'Iquitos', 'GENERAL', '120.00', day(0), day(10), 'CURRENT'],
    ]);
    expect((await quote(a, 'pucallpa', 'iquitos', 'GENERAL', day(9))).body.amount).toBe('120.00');
    expect((await quote(a, 'pucallpa', 'iquitos', 'GENERAL', day(10))).body.amount).toBe('130.00');

    // Otro cambio desde el día 5: el de 120 terminaría ese día, pero el de 130 (desde el 10) se solaparía → 409, y
    // nada cambia (el de 120 sigue terminando el día 10).
    const clash = await create(a, {
      validFrom: day(5),
      items: [
        item('pucallpa', 'contamana', 'GENERAL', '40.00'),
        item('pucallpa', 'iquitos', 'GENERAL', '125.00'),
      ],
    });
    expect([clash.status, clash.body.error.message]).toEqual([
      409,
      `Ya hay una tarifa GENERAL de Pucallpa a Iquitos desde el ${dmy(10)}: anúlala o cambia la vigencia de la nueva`,
    ]);
    expect((await quote(a, 'pucallpa', 'iquitos', 'GENERAL', day(7))).body.amount).toBe('120.00');
    expect((await quote(a, 'pucallpa', 'contamana', 'GENERAL', day(7))).body.amount).toBe('35.50');

    // Una tarifa temporal (con fin) antes de la programada sí cabe.
    const promo = await create(a, {
      validFrom: day(5),
      validTo: day(10),
      items: [item('pucallpa', 'iquitos', 'GENERAL', '110.00')],
    });
    expect(promo.status).toBe(201);
    expect(promo.body.ended.map(summary)).toEqual([
      ['Pucallpa', 'Iquitos', 'GENERAL', '120.00', day(0), day(5), 'CURRENT'],
    ]);
    expect(
      await Promise.all(
        [4, 5, 9, 10].map(
          async (d) => (await quote(a, 'pucallpa', 'iquitos', 'GENERAL', day(d))).body.amount,
        ),
      ),
    ).toEqual(['120.00', '110.00', '110.00', '130.00']);
  });

  it('validación: el pasado no cambia, pares de la ruta en su sentido, servicios que la empresa opera, montos y ruta activa', async () => {
    const fail = async (body: object, status: number, message?: string, route = routeId) => {
      const res = await create(a, body, route);
      expect(res.status).toBe(status);
      if (message) expect(res.body.error.message).toBe(message);
    };
    const one = [item('contamana', 'yurimaguas', 'GENERAL', '50.00')];
    await fail(
      { validFrom: day(-1), items: one },
      400,
      'La vigencia empieza hoy o más adelante: el pasado no cambia',
    );
    await fail(
      { validFrom: day(0), items: [item('iquitos', 'contamana', 'GENERAL', '50.00')] },
      400,
      'En esta ruta no se viaja de Iquitos a Contamana',
    );
    await fail(
      { validFrom: day(0), items: [item('pucallpa', 'requena', 'GENERAL', '50.00')] },
      400,
      'Una de las tarifas es de una ubicación que no es parada de la ruta',
    );
    await fail(
      { validFrom: day(0), service: 'VEHICLE_TRANSPORT', items: one },
      400,
      'La empresa no opera transporte de vehículos en esta modalidad',
    );
    await fail({ validFrom: day(0), service: 'CARGO', items: one }, 400);
    await fail({ validFrom: day(0), items: [item('contamana', 'yurimaguas', 'GENERAL', '0')] }, 400);
    await fail({ validFrom: day(0), validTo: day(0), items: one }, 400);
    await fail({ validFrom: day(0), items: [...one, ...one] }, 400);
    await fail({ validFrom: day(0), items: [] }, 400);
    await fail(
      { validFrom: day(0), items: one },
      404,
      'Recurso no encontrado',
      '0190f0a0-0000-7000-8000-000000000999',
    );
    await fail({ validFrom: day(0), items: one }, 404, undefined, 'no-es-un-id');

    // Una ruta archivada no recibe tarifas.
    const other = await as(a, 'post', '/api/v1/routes', {
      code: 'CTM-YMS',
      name: 'Contamana – Yurimaguas',
      modality: 'RIVER',
      stops: [stop('contamana', 0), stop('yurimaguas', 600)],
    });
    expect((await as(a, 'post', `/api/v1/routes/${other.body.id}/archive`)).status).toBe(200);
    await fail(
      { validFrom: day(0), items: one },
      409,
      'La ruta está archivada: restáurala antes de ponerle tarifas',
      other.body.id,
    );
    // Nada de lo anterior se guardó.
    expect((await as(a, 'get', fares())).body.fares).toHaveLength(6);
  });

  it('terminar y anular: el fin no va al pasado; una tarifa que ya empezó no se anula; anulada es definitiva', async () => {
    const list = (await as(a, 'get', fares())).body.fares as Record<string, string>[];
    const find = (o: string, d: string, c: string, from: string) =>
      list.find(
        (f) =>
          f.originName === o && f.destinationName === d && f.priceClassCode === c && f.validFrom === from,
      )?.id as string;
    const cama = find('Pucallpa', 'Iquitos', 'CAMA', day(0));
    const scheduled = find('Pucallpa', 'Iquitos', 'GENERAL', day(10));

    const end = (id: string, validTo: string) => as(a, 'post', `/api/v1/fares/${id}/end`, { validTo });
    const expectError = async (res: request.Response, status: number, message: string) =>
      expect([res.status, res.body.error?.message]).toEqual([status, message]);

    await expectError(await end(cama, day(-1)), 400, 'El fin es hoy o más adelante: el pasado no cambia');
    await expectError(await end(scheduled, day(10)), 400, 'El fin es posterior al inicio');
    const ended = await end(cama, day(30));
    expect(summary(ended.body)).toEqual([
      'Pucallpa',
      'Iquitos',
      'CAMA',
      '180.00',
      day(0),
      day(30),
      'CURRENT',
    ]);
    expect((await quote(a, 'pucallpa', 'iquitos', 'CAMA', day(30))).status).toBe(404);
    // Alargar la promoción hasta pisar la tarifa programada: solapamiento (la base lo impide).
    const promo = find('Pucallpa', 'Iquitos', 'GENERAL', day(5));
    await expectError(
      await end(promo, day(11)),
      409,
      'Ya hay una tarifa activa para ese tramo y esa clase en esas fechas',
    );

    await expectError(
      await as(a, 'post', `/api/v1/fares/${cama}/cancel`),
      409,
      'La tarifa ya empezó: ponle fin en vez de anularla',
    );
    const cancelled = await as(a, 'post', `/api/v1/fares/${scheduled}/cancel`);
    expect([cancelled.status, cancelled.body.status, cancelled.body.phase]).toEqual([
      200,
      'CANCELLED',
      'CANCELLED',
    ]);
    await expectError(
      await as(a, 'post', `/api/v1/fares/${scheduled}/cancel`),
      409,
      'La tarifa ya está anulada',
    );
    await expectError(await end(scheduled, day(20)), 409, 'La tarifa está anulada');
    // Sin la programada, desde el día 10 no hay precio GENERAL (la promoción termina ese día): no se restaura nada.
    expect((await quote(a, 'pucallpa', 'iquitos', 'GENERAL', day(10))).status).toBe(404);
    // Ahora la promoción sí se alarga.
    expect((await end(promo, day(60))).body.validTo).toBe(day(60));

    // Una tarifa que ya terminó (cargada con fechas pasadas) no se reabre.
    const past = (
      await inTenant(
        a,
        (c) =>
          c.query<{ id: string }>(
            `INSERT INTO fares (id, tenant_id, route_id, origin_location_id, destination_location_id, service,
                                price_class_code, amount, valid_from, valid_to)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PASSENGER', 'VIP', 150, $5, $6) RETURNING id`,
            [a.id, routeId, loc.pucallpa, loc.iquitos, day(-30), day(-1)],
          ),
        true,
      )
    ).rows[0]?.id as string;
    await expectError(await end(past, day(10)), 409, 'La tarifa ya terminó');
    const phases = ((await as(a, 'get', fares())).body.fares as Record<string, string>[]).map((f) => [
      f.priceClassCode,
      f.validFrom,
      f.phase,
    ]);
    expect(phases).toContainEqual(['VIP', day(-30), 'ENDED']);
    expect(phases).toContainEqual(['GENERAL', day(10), 'CANCELLED']);
    expect(await as(a, 'post', `/api/v1/fares/no-es-un-id/end`, { validTo: day(1) })).toMatchObject({
      status: 404,
    });
  });

  it('matriz: pares × clases de los planos asignados y de las tarifas, con lo que falta; pares que dejan de ser de la ruta', async () => {
    // La lancha de la 6.6 (camarotes con camas, zona libre y asientos), publicada y asignada desde hoy.
    const layout = await as(a, 'post', '/api/v1/layouts', {
      name: 'Lancha',
      modality: 'RIVER',
      vehicleTypeId: null,
      document: boatTemplate(),
    });
    expect(layout.status).toBe(201);
    expect((await as(a, 'post', `/api/v1/layouts/${layout.body.layoutId}/publish`)).status).toBe(200);
    const type = await as(a, 'post', '/api/v1/vehicle-types', {
      name: 'Lancha',
      modality: 'RIVER',
      catalogCode: null,
    });
    const vehicle = await as(a, 'post', '/api/v1/vehicles', {
      code: 'LANCHA-01',
      name: 'Lancha 01',
      vehicleTypeId: type.body.id,
      registration: 'LANCHA-01-2026',
      status: 'ACTIVE',
      ownership: 'OWN',
      nominalCapacity: { passengers: null, weightKg: null, volumeM3: null },
      features: [],
    });
    expect(vehicle.status).toBe(201);
    const assigned = await as(a, 'post', `/api/v1/vehicles/${vehicle.body.id}/layout-assignments`, {
      layoutId: layout.body.layoutId,
      version: 1,
      validFrom: day(0),
      validTo: null,
    });
    expect(assigned.status).toBe(201);

    const matrix = await as(a, 'get', fares(`/matrix?date=${day(1)}`));
    expect(matrix.status).toBe(200);
    expect(matrix.body).toMatchObject({ routeId, service: 'PASSENGER', date: day(1) });
    expect(
      matrix.body.pairs.map((p: Record<string, string>) => `${p.originName}→${p.destinationName}`),
    ).toEqual([
      'Pucallpa→Contamana',
      'Pucallpa→Yurimaguas',
      'Pucallpa→Iquitos',
      'Contamana→Yurimaguas',
      'Contamana→Iquitos',
      'Yurimaguas→Iquitos',
    ]);
    expect(matrix.body.classes).toEqual([
      { code: 'CAMA', inLayouts: true },
      { code: 'CAMAROTE', inLayouts: true },
      { code: 'GENERAL', inLayouts: true },
    ]);
    // Día 1: GENERAL de P→C, P→I y C→I, y CAMA de P→I. Faltan 6 × 3 − 4 = 14.
    expect(matrix.body.fares.map(summary).map((s: unknown[]) => s.slice(0, 4))).toEqual([
      ['Pucallpa', 'Contamana', 'GENERAL', '35.50'],
      ['Pucallpa', 'Iquitos', 'CAMA', '180.00'],
      ['Pucallpa', 'Iquitos', 'GENERAL', '120.00'],
      ['Contamana', 'Iquitos', 'GENERAL', '95.00'],
    ]);
    expect(matrix.body.missing).toHaveLength(14);
    expect(matrix.body.missing[0]).toEqual({
      originLocationId: loc.pucallpa,
      destinationLocationId: loc.contamana,
      priceClassCode: 'CAMA',
    });
    // Sin precio ese día, CAMA desaparece de las tarifas pero sigue en las clases (es del plano).
    const later = await as(a, 'get', fares(`/matrix?date=${day(30)}&service=PASSENGER`));
    expect(later.body.fares.map((f: Record<string, string>) => f.priceClassCode)).not.toContain('CAMA');
    expect(later.body.missing).toHaveLength(15);
    // Una clase con tarifa que no está en los planos también aparece.
    expect(
      (await create(a, { validFrom: day(1), items: [item('yurimaguas', 'iquitos', 'VIP', '99.90')] })).status,
    ).toBe(201);
    const withVip = await as(a, 'get', fares(`/matrix?date=${day(1)}`));
    expect(withVip.body.classes).toContainEqual({ code: 'VIP', inLayouts: false });
    expect(withVip.body.missing).toHaveLength(6 * 4 - 5);
    expect((await as(a, 'get', fares('/matrix?service=CARGO'))).status).toBe(400);

    // Sin Contamana en la ruta, sus tarifas se conservan fuera de la ruta y no se cotizan.
    const edited = await as(a, 'put', `/api/v1/routes/${routeId}`, {
      name: 'Pucallpa – Iquitos',
      stops: amazonas().filter((s) => s.locationId !== loc.contamana),
    });
    expect(edited.status).toBe(200);
    const off = ((await as(a, 'get', fares())).body.fares as Record<string, unknown>[])
      .filter((f) => !f.onRoute)
      .map((f) => `${f.originName}→${f.destinationName}`);
    expect(off).toEqual(['Pucallpa→Contamana', 'Contamana→Iquitos']);
    expect((await quote(a, 'contamana', 'iquitos', 'GENERAL')).status).toBe(400);
    const smaller = await as(a, 'get', fares(`/matrix?date=${day(1)}`));
    expect(smaller.body.pairs).toHaveLength(3);
    expect(smaller.body.fares.map((f: Record<string, string>) => f.originName)).not.toContain('Contamana');
    // Al volver Contamana, vuelven sus tarifas.
    expect(
      (await as(a, 'put', `/api/v1/routes/${routeId}`, { name: 'Pucallpa – Iquitos', stops: amazonas() }))
        .status,
    ).toBe(200);
    expect((await quote(a, 'contamana', 'iquitos', 'GENERAL')).body.amount).toBe('95.00');
  });

  it('reglas de la base: sin solapamientos (EXCLUDE), CHECK por fila, monto e inicio fijos, sin borrar, anulada definitiva', async () => {
    const insert = (c: PoolClient, values: Record<string, unknown> = {}) => {
      const v = {
        origin: loc.yurimaguas,
        destination: loc.iquitos,
        service: 'PASSENGER',
        cls: 'GENERAL',
        currency: 'PEN',
        amount: 80,
        from: day(100),
        to: null as string | null,
        status: 'ACTIVE',
        cancelled: null as string | null,
        ...values,
      };
      return c.query(
        `INSERT INTO fares (id, tenant_id, route_id, origin_location_id, destination_location_id, service,
                            price_class_code, currency, amount, valid_from, valid_to, status, cancelled_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          a.id,
          routeId,
          v.origin,
          v.destination,
          v.service,
          v.cls,
          v.currency,
          v.amount,
          v.from,
          v.to,
          v.status,
          v.cancelled,
        ],
      );
    };
    const rejects = (fn: (c: PoolClient) => Promise<unknown>, code: string) =>
      expect(inTenant(a, fn)).rejects.toMatchObject({ code });

    // Dos activas de la misma clave con días en común → 23P01; contiguas, de otra clase o anulada, sí.
    await rejects(async (c) => {
      await insert(c);
      await insert(c, { from: day(120) });
    }, '23P01');
    await inTenant(a, async (c) => {
      await insert(c, { to: day(120) });
      await insert(c, { from: day(120) });
      await insert(c, { cls: 'CAMA' });
      await insert(c, { status: 'CANCELLED', cancelled: new Date().toISOString() });
    });
    for (const [values, constraint] of [
      [{ amount: 0 }, 'fares_amount'],
      [{ currency: 'USD' }, 'fares_currency'],
      [{ service: 'CARGO' }, 'fares_service'],
      [{ cls: 'general' }, 'fares_price_class'],
      [{ destination: loc.yurimaguas }, 'fares_pair'],
      [{ to: day(100) }, 'fares_dates'],
      [{ status: 'CANCELLED' }, 'fares_cancelled'],
    ] as const) {
      await expect(inTenant(a, (c) => insert(c, values))).rejects.toMatchObject({
        code: '23514',
        constraint,
      });
    }
    await rejects((c) => insert(c, { amount: 100000 }), '22003');

    const id = (await as(a, 'get', fares())).body.fares[0].id as string;
    for (const sql of [
      `UPDATE fares SET amount = 1 WHERE id = $1`,
      `UPDATE fares SET valid_from = valid_from - 1 WHERE id = $1`,
      `UPDATE fares SET price_class_code = 'VIP' WHERE id = $1`,
      `UPDATE fares SET route_id = route_id WHERE id = $1`,
      `DELETE FROM fares WHERE id = $1`,
    ]) {
      await rejects((c) => c.query(sql, [id]), '42501');
    }
    // Anulada es definitiva, aunque se intente con las columnas permitidas.
    const cancelledId = ((await as(a, 'get', fares())).body.fares as Record<string, string>[]).find(
      (f) => f.status === 'CANCELLED',
    )?.id;
    await expect(
      inTenant(a, (c) =>
        c.query(`UPDATE fares SET status = 'ACTIVE', cancelled_at = NULL WHERE id = $1`, [cancelledId]),
      ),
    ).rejects.toMatchObject({ code: 'P0001', message: 'fares: una tarifa anulada no cambia' });
  });

  it('aislamiento: otra empresa no ve, cotiza, termina ni anula las tarifas de esta (404), ni por RLS', async () => {
    const someId = (await as(a, 'get', fares())).body.fares[0].id as string;
    expect((await as(b, 'get', fares())).status).toBe(404);
    expect((await as(b, 'get', fares('/matrix'))).status).toBe(404);
    expect((await quote(b, 'pucallpa', 'iquitos', 'GENERAL')).status).toBe(404);
    expect(
      (await create(b, { validFrom: day(0), items: [item('pucallpa', 'iquitos', 'GENERAL', '1.00')] }))
        .status,
    ).toBe(404);
    expect((await as(b, 'post', `/api/v1/fares/${someId}/end`, { validTo: day(90) })).status).toBe(404);
    expect((await as(b, 'post', `/api/v1/fares/${someId}/cancel`)).status).toBe(404);
    expect(
      await inTenant(b, async (c) => (await c.query('SELECT count(*)::int AS n FROM fares')).rows[0].n),
    ).toBe(0);
    const pool = testPool('app', DB, 1);
    try {
      expect((await pool.query('SELECT count(*)::int AS n FROM fares')).rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('permisos: sin fares.manage → 403; sin sesión → 401; empresa suspendida consulta pero no configura', async () => {
    const userId = (
      await seed.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), 'cajera@tarifas-a.pe', 'x', 'Cajera', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0]?.id as string;
    await seed.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [a.id, userId],
    );
    const someId = (await as(a, 'get', fares())).body.fares[0].id as string;
    expect((await as(a, 'get', fares(), undefined, userId)).status).toBe(403);
    expect((await as(a, 'post', `/api/v1/fares/${someId}/cancel`, undefined, userId)).status).toBe(403);
    expect((await http().get(fares()).set('Host', a.host)).status).toBe(401);

    const to = (status: string) =>
      asStaff('post', `/api/v1/platform/tenants/${a.id}/status`, { to: status, reason: 'Prueba 7.2' });
    expect((await to('PAST_DUE')).status).toBe(200);
    expect((await to('SUSPENDED')).status).toBe(200);
    try {
      expect((await as(a, 'get', fares())).status).toBe(200);
      expect((await quote(a, 'pucallpa', 'iquitos', 'CAMA')).status).toBe(200);
      expect(
        (await create(a, { validFrom: day(200), items: [item('pucallpa', 'iquitos', 'VIP', '1.00')] }))
          .status,
      ).toBe(403);
      expect((await as(a, 'post', `/api/v1/fares/${someId}/end`, { validTo: day(90) })).status).toBe(403);
    } finally {
      expect((await to('ACTIVE')).status).toBe(200);
    }
  });
});
