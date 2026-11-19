/**
 * Fase 7.3b · Programaciones (data-dictionary §5; F7-Q2). PostgreSQL y Redis reales: recurrencia diaria o semanal,
 * hora local, vigencia y fechas excluidas; generación hasta el horizonte de 60 días, idempotente, con la unidad por
 * defecto si está libre en cada fecha (si no, sin unidad y con el motivo); fechas omitidas (hora pasada, la ruta ya
 * tiene un viaje a esa hora); un viaje generado y cancelado no se regenera; editar no cambia lo generado; el job del
 * worker recorre las empresas operativas; reglas de la base, aislamiento (RLS), permisos y estados del tenant.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { boatTemplate, busTemplate } from '@yebo/contracts';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { PERMISSION_CODES } from '../../src/modules/access/permission-catalog';
import { SessionService } from '../../src/modules/identity/session.service';
import { ScheduleRunnerService } from '../../src/modules/trips/schedule-runner.service';
import { TRIP_SCHEDULES_QUEUE } from '../../src/modules/trips/schedules.worker';
import { WorkerModule } from '../../src/worker.module';
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

describe('Fase 7.3b · programaciones', () => {
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
      await seedPlatformSession(seed, {
        email: 'programaciones@yebo.pe',
        role: 'SUPERADMIN',
        now: new Date(),
      })
    ).cookie;
    const plan = await asStaff('post', '/api/v1/platform/plans', {
      code: 'programaciones',
      name: 'Programaciones',
    });
    const v = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
      basePrice: '99.00',
      billingInterval: 'MONTHLY',
      includedUsers: 5,
      extraUserPrice: '15.00',
      trialDays: 0,
      modules: ['PASSENGERS'],
    });
    await asStaff('post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
    a = await company('prog-a', v.body.id);
    b = await company('prog-b', v.body.id);
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
  const DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const dow = (offset: number) => DOW[new Date(`${day(offset)}T00:00:00Z`).getUTCDay()] as string;
  const limaTime = () =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date());

  let routeId = '';
  let route2 = '';
  const ids = { lancha: '', boatLayout: '', busLayout: '', bus: '', draftLayout: '' };
  let weekly = '';
  let daily = '';

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
  const expectError = (res: request.Response, status: number, message?: string) => {
    expect([res.status, message === undefined ? undefined : res.body.error?.message]).toEqual([
      status,
      message,
    ]);
  };
  const schedule = (over: object = {}) => ({
    code: 'PCL-LUN-JUE',
    routeId,
    recurrence: { frequency: 'WEEKLY', weekdays: ['TH', 'MO'] },
    departureTime: '07:00',
    validFrom: day(0),
    validTo: null,
    excludedDates: [],
    vehicleId: ids.lancha,
    layout: null,
    ...over,
  });
  const edit = (over: object = {}) => {
    const { code: _c, routeId: _r, ...rest } = schedule(over);
    return rest;
  };
  const generate = (c: Company, id: string) => as(c, 'post', `/api/v1/schedules/${id}/generate`);

  it('generar: lunes y jueves a las 07:00 hasta 60 días, sin la fecha excluida; la lancha donde está libre', async () => {
    const route = await as(a, 'post', '/api/v1/routes', {
      code: 'PCL-IQT',
      name: 'Pucallpa – Iquitos',
      modality: 'RIVER',
      stops: amazonas(),
    });
    routeId = route.body.id;
    const other = await as(a, 'post', '/api/v1/routes', {
      code: 'CTM-YMS',
      name: 'Contamana – Yurimaguas',
      modality: 'RIVER',
      stops: [stop('contamana', 0), stop('yurimaguas', 600)],
    });
    route2 = other.body.id;
    ids.boatLayout = await layout('Lancha', 'RIVER', boatTemplate());
    ids.draftLayout = await layout('Borrador', 'RIVER', boatTemplate(), false);
    ids.busLayout = await layout('Bus', 'LAND', busTemplate());
    ids.lancha = await vehicle('LANCHA-01', 'RIVER', ids.boatLayout);
    ids.bus = await vehicle('BUS-01', 'LAND', ids.busLayout);

    // El primer jueves desde dentro de una semana queda excluido (feriado).
    const excluded = [...Array(14).keys()].map((n) => n + 7).find((o) => dow(o) === 'TH') as number;
    const created = await as(
      a,
      'post',
      '/api/v1/schedules',
      schedule({ code: ' pcl-lun-jue ', excludedDates: [day(excluded)] }),
    );
    expect(created.status).toBe(201);
    weekly = created.body.id;
    expect(created.body).toMatchObject({
      code: 'PCL-LUN-JUE',
      routeCode: 'PCL-IQT',
      recurrence: { frequency: 'WEEKLY', weekdays: ['MO', 'TH'] },
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
      departureTime: '07:00',
      timezone: 'America/Lima',
      validFrom: day(0),
      validTo: null,
      excludedDates: [day(excluded)],
      vehicle: { code: 'LANCHA-01' },
      layout: null,
      archived: false,
      generatedUntil: null,
    });

    // Lo esperado, calculado aparte: fechas lunes y jueves en [hoy, hoy + 60), sin la excluida; la de hoy se omite si
    // ya pasaron las 07:00 en Lima. La lancha tarda 84 h (3 días y medio): toma una salida si ya volvió de la anterior.
    const offsets = [...Array(60).keys()].filter((o) => ['MO', 'TH'].includes(dow(o)) && o !== excluded);
    const passed = offsets[0] === 0 && limaTime() >= '07:00';
    const dates = passed ? offsets.slice(1) : offsets;
    let free = 0;
    const withUnit = new Set<number>();
    for (const o of dates) {
      const departure = Date.parse(`${day(o)}T12:00:00Z`); // 07:00 en Lima
      if (departure >= free) {
        withUnit.add(o);
        free = departure + 84 * 3_600_000;
      }
    }

    const run = await generate(a, weekly);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ scheduleId: weekly, from: day(0), until: day(60), existing: 0 });
    expect(run.body.created.map((c: Record<string, unknown>) => [c.date, c.vehicleCode])).toEqual(
      dates.map((o) => [day(o), withUnit.has(o) ? 'LANCHA-01' : null]),
    );
    expect(run.body.skipped).toEqual(passed ? [{ date: day(0), reason: 'La hora de salida ya pasó' }] : []);
    expect(run.body.withoutUnit.map((w: { date: string }) => w.date)).toEqual(
      dates.filter((o) => !withUnit.has(o)).map(day),
    );
    for (const w of run.body.withoutUnit) {
      expect(w.reason).toMatch(/^La unidad LANCHA-01 ya está en el viaje PCL-IQT-\d{6}-0700 en ese horario$/);
    }
    expect(withUnit.size).toBeGreaterThan(0);
    expect(run.body.withoutUnit.length).toBeGreaterThan(0);

    // Cada viaje: SCHEDULED, a las 07:00 locales, con su código; con la lancha, su plano asignado e inventario.
    const first = run.body.created[0];
    const trip = await as(a, 'get', `/api/v1/trips/${first.tripId}`);
    expect(trip.body).toMatchObject({
      code: `PCL-IQT-${first.date.slice(2).replaceAll('-', '')}-0700`,
      departureKind: 'SCHEDULED',
      status: 'PLANNED',
      departureLocal: `${first.date}T07:00`,
      vehicle: { code: 'LANCHA-01' },
      layout: { name: 'Lancha' },
    });
    expect(trip.body.inventory.resources).toBeGreaterThan(0);
    const unitless = run.body.created.find((c: { vehicleCode: string | null }) => c.vehicleCode === null);
    expect((await as(a, 'get', `/api/v1/trips/${unitless.tripId}`)).body).toMatchObject({
      vehicle: null,
      inventory: null,
    });
    const inDb = await inTenant(a, (c) =>
      c.query<{ n: number; dates: number }>(
        `SELECT count(*)::int AS n, count(DISTINCT departure_date)::int AS dates FROM trips
          WHERE schedule_id = $1 AND departure_kind = 'SCHEDULED'`,
        [weekly],
      ),
    );
    expect(inDb.rows[0]).toEqual({ n: dates.length, dates: dates.length });

    const saved = (await as(a, 'get', `/api/v1/schedules/${weekly}`)).body;
    expect(saved.generatedUntil).toBe(day(60));
    expect(saved.lastGeneratedAt).not.toBeNull();

    // Idempotente: otra vez no crea nada.
    const again = await generate(a, weekly);
    expect([again.body.created, again.body.existing, again.body.withoutUnit]).toEqual([[], dates.length, []]);
  });

  it('reglas: vigencia, la ruta ya ocupada a esa hora, un generado cancelado no vuelve; editar no cambia lo generado', async () => {
    // Un viaje puntual de la ruta 2 el día 5 a las 18:00 ocupa esa hora.
    const manual = await as(a, 'post', '/api/v1/trips', {
      routeId: route2,
      departureLocal: at(5, '18:00'),
      vehicleId: null,
      layout: null,
      minPassengers: null,
      confirmationDeadlineLocal: null,
    });
    expect(manual.status).toBe(201);
    const created = await as(
      a,
      'post',
      '/api/v1/schedules',
      schedule({
        code: 'DIARIO',
        routeId: route2,
        recurrence: { frequency: 'DAILY' },
        departureTime: '18:00',
        validFrom: day(1),
        validTo: day(8),
        excludedDates: [day(3)],
        vehicleId: null,
      }),
    );
    expect(created.status).toBe(201);
    daily = created.body.id;
    const run = await generate(a, daily);
    expect(run.body).toMatchObject({ from: day(1), until: day(8), existing: 0, withoutUnit: [] });
    expect(run.body.created.map((c: { date: string }) => c.date)).toEqual([1, 2, 4, 6, 7].map(day));
    expect(run.body.skipped).toEqual([
      { date: day(5), reason: `La ruta ya tiene el viaje ${manual.body.code} a esa hora` },
    ]);

    // Se cancela el del día 2: no se vuelve a generar.
    const second = run.body.created[1].tripId as string;
    expect(
      (await as(a, 'post', `/api/v1/trips/${second}/cancel`, { reason: 'Mantenimiento del puerto' })).status,
    ).toBe(200);
    const again = await generate(a, daily);
    expect([again.body.created, again.body.existing]).toEqual([[], 5]);
    expect(again.body.skipped).toEqual([
      { date: day(5), reason: `La ruta ya tiene el viaje ${manual.body.code} a esa hora` },
    ]);

    // Editar la hora y la vigencia: lo generado sigue a las 18:00; lo que se genere después sale a las 19:00.
    const edited = await as(
      a,
      'put',
      `/api/v1/schedules/${daily}`,
      edit({
        recurrence: { frequency: 'DAILY' },
        departureTime: '19:00',
        validFrom: day(1),
        validTo: day(10),
        excludedDates: [day(3)],
        vehicleId: null,
      }),
    );
    expect(edited.status).toBe(200);
    const more = await generate(a, daily);
    // A las 19:00, el día 5 ya no choca con el viaje puntual de las 18:00: ahora se genera.
    expect(more.body.created.map((c: { date: string }) => c.date)).toEqual([day(5), day(8), day(9)]);
    expect(more.body.existing).toBe(5);
    expect(more.body.skipped).toEqual([]);
    const trips = (await as(a, 'get', `/api/v1/trips?from=${day(1)}&to=${day(9)}&routeId=${route2}`)).body
      .trips as {
      departureLocal: string;
      departureKind: string;
      status: string;
    }[];
    expect(trips.map((t) => [t.departureLocal, t.departureKind, t.status])).toEqual([
      [at(1, '18:00'), 'SCHEDULED', 'PLANNED'],
      [at(2, '18:00'), 'SCHEDULED', 'CANCELLED'],
      [at(4, '18:00'), 'SCHEDULED', 'PLANNED'],
      [at(5, '18:00'), 'ON_DEMAND', 'PLANNED'],
      [at(5, '19:00'), 'SCHEDULED', 'PLANNED'],
      [at(6, '18:00'), 'SCHEDULED', 'PLANNED'],
      [at(7, '18:00'), 'SCHEDULED', 'PLANNED'],
      [at(8, '19:00'), 'SCHEDULED', 'PLANNED'],
      [at(9, '19:00'), 'SCHEDULED', 'PLANNED'],
    ]);

    // Archivada no genera ni se edita; restaurada, sí.
    expect((await as(a, 'post', `/api/v1/schedules/${daily}/archive`)).body.archived).toBe(true);
    expectError(await generate(a, daily), 409, 'La programación está archivada');
    expectError(
      await as(a, 'put', `/api/v1/schedules/${daily}`, edit({ vehicleId: null })),
      409,
      'La programación está archivada: restáurala antes de editarla',
    );
    expect((await as(a, 'post', `/api/v1/schedules/${daily}/restore`)).body.archived).toBe(false);
    expect(
      (await as(a, 'get', '/api/v1/schedules')).body.schedules.map((s: { code: string }) => s.code),
    ).toEqual(['DIARIO', 'PCL-LUN-JUE']);
  });

  it('validación: código único, vigencia desde hoy, días, ruta, unidad y plano como en un viaje', async () => {
    const post = (over: object) => as(a, 'post', '/api/v1/schedules', schedule({ code: 'OTRA', ...over }));
    expectError(
      await post({ code: 'PCL-LUN-JUE' }),
      409,
      'Ya existe una programación con el código PCL-LUN-JUE',
    );
    expectError(await post({ validFrom: day(-1) }), 400, 'La vigencia empieza hoy o más adelante');
    expect((await post({ recurrence: { frequency: 'WEEKLY', weekdays: [] } })).status).toBe(400);
    expect((await post({ recurrence: { frequency: 'WEEKLY', weekdays: ['MO', 'MO'] } })).status).toBe(400);
    expect((await post({ recurrence: { frequency: 'MONTHLY' } })).status).toBe(400);
    expect((await post({ departureTime: '24:00' })).status).toBe(400);
    expect((await post({ validTo: day(0) })).status).toBe(400);
    expect((await post({ excludedDates: [day(3), day(3)] })).status).toBe(400);
    expect((await post({ vehicleId: null, layout: { layoutId: ids.boatLayout, version: 1 } })).status).toBe(
      400,
    );
    expectError(await post({ vehicleId: ids.bus }), 400, 'La unidad BUS-01 es de otra modalidad que la ruta');
    expectError(
      await post({ layout: { layoutId: ids.draftLayout, version: 1 } }),
      400,
      'Solo se usa una versión publicada del plano',
    );
    expectError(
      await post({ routeId: '0190f0a0-0000-7000-8000-000000000999' }),
      400,
      'La ruta no es de la empresa',
    );
    // Con un plano elegido, los viajes lo usan.
    const chosen = await post({
      code: 'ELEGIDO',
      layout: { layoutId: ids.boatLayout, version: 1 },
      validFrom: day(70),
    });
    expect([chosen.status, chosen.body.layout?.name]).toEqual([201, 'Lancha']);
    // La salida de hoy a las 00:00 ya pasó: se omite con su motivo.
    const dawn = await post({
      code: 'MADRUGADA',
      routeId: route2,
      recurrence: { frequency: 'DAILY' },
      departureTime: '00:00',
      validTo: day(2),
      vehicleId: null,
    });
    const dawnRun = await generate(a, dawn.body.id);
    expect(dawnRun.body.skipped).toEqual([{ date: day(0), reason: 'La hora de salida ya pasó' }]);
    expect(dawnRun.body.created.map((c: { date: string }) => c.date)).toEqual([day(1)]);
    // Fuera del horizonte: no genera nada aún.
    const far = await generate(a, chosen.body.id);
    expect([far.body.created, far.body.from, far.body.until]).toEqual([[], day(70), day(60)]);
  });

  it('job del worker: genera en las empresas operativas (no en una suspendida), es idempotente y tiene un planificador', async () => {
    // La empresa B, con su ruta y una programación diaria, suspendida.
    const locs: string[] = [];
    for (const place of [PLACES.pucallpa, PLACES.contamana]) {
      locs.push((await as(b, 'post', '/api/v1/locations', { ...place, ubigeo: null, region: null })).body.id);
    }
    const bRoute = await as(b, 'post', '/api/v1/routes', {
      code: 'B-RUTA',
      name: 'Ruta de B',
      modality: 'RIVER',
      stops: [
        {
          locationId: locs[0],
          offsetMinutes: 0,
          dwellMinutes: 0,
          allowsBoarding: true,
          allowsAlighting: true,
          pathToNext: null,
        },
        {
          locationId: locs[1],
          offsetMinutes: 600,
          dwellMinutes: 0,
          allowsBoarding: true,
          allowsAlighting: true,
          pathToNext: null,
        },
      ],
    });
    const bSchedule = await as(b, 'post', '/api/v1/schedules', {
      ...schedule({
        code: 'B-DIARIO',
        routeId: bRoute.body.id,
        recurrence: { frequency: 'DAILY' },
        vehicleId: null,
      }),
      validFrom: day(1),
      validTo: day(3),
    });
    expect(bSchedule.status).toBe(201);
    // Y en A, una programación nueva sin generar.
    const night = await as(
      a,
      'post',
      '/api/v1/schedules',
      schedule({
        code: 'NOCHE',
        routeId: route2,
        recurrence: { frequency: 'DAILY' },
        departureTime: '21:00',
        validFrom: day(1),
        validTo: day(4),
        vehicleId: null,
      }),
    );
    expect(night.status).toBe(201);
    const to = (status: string) =>
      asStaff('post', `/api/v1/platform/tenants/${b.id}/status`, { to: status, reason: 'Prueba 7.3b' });
    expect((await to('PAST_DUE')).status).toBe(200);
    expect((await to('SUSPENDED')).status).toBe(200);
    const runner = app.get(ScheduleRunnerService);
    const bTrips = async () =>
      inTenant(b, async (c) => (await c.query('SELECT count(*)::int AS n FROM trips')).rows[0].n as number);
    try {
      const first = await runner.runDue();
      expect(first).toEqual({ tenants: 1, schedules: 5, created: 3, failed: 0 });
      expect(await bTrips()).toBe(0);
    } finally {
      expect((await to('ACTIVE')).status).toBe(200);
    }
    const second = await runner.runDue();
    expect(second).toEqual({ tenants: 2, schedules: 6, created: 2, failed: 0 });
    expect(await bTrips()).toBe(2);
    expect(await runner.runDue()).toEqual({ tenants: 2, schedules: 6, created: 0, failed: 0 });

    // El worker registra un único planificador diario (00:30 de Lima).
    const ref = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    const worker = ref.createNestApplication({ bufferLogs: true });
    await worker.init();
    try {
      const queue = worker.get<Queue>(getQueueToken(TRIP_SCHEDULES_QUEUE));
      const schedulers = (await queue.getJobSchedulers()).filter((s) => s.key === 'trip-schedules-generate');
      expect(schedulers.map((s) => [s.pattern, s.tz])).toEqual([['30 0 * * *', 'America/Lima']]);
    } finally {
      await worker.close();
    }
  });

  it('reglas de la base: viaje SCHEDULED con su programación y fecha, una por fecha, CHECK y privilegios', async () => {
    const rejects = (fn: (c: PoolClient) => Promise<unknown>, code: string) =>
      expect(inTenant(a, fn)).rejects.toMatchObject({ code });
    const insertTrip = (
      c: PoolClient,
      kind: string,
      scheduleId: string | null,
      date: string | null,
      dep: string,
    ) =>
      c.query(
        `INSERT INTO trips (id, tenant_id, code, route_id, departure_kind, schedule_id, departure_date,
                            planned_departure_at, planned_arrival_at)
         VALUES (gen_random_uuid(), $1, 'DB-X', $2, $3, $4, $5, $6, $6::timestamptz + interval '10 hours')`,
        [a.id, route2, kind, scheduleId, date, dep],
      );
    await rejects((c) => insertTrip(c, 'SCHEDULED', null, null, `${day(90)}T12:00:00Z`), '23514');
    await rejects((c) => insertTrip(c, 'ON_DEMAND', daily, day(90), `${day(90)}T12:00:00Z`), '23514');
    await rejects((c) => insertTrip(c, 'SCHEDULED', daily, day(1), `${day(91)}T12:00:00Z`), '23505');
    const insertSchedule = (c: PoolClient, over: Record<string, unknown>) => {
      const v = { recurrence: 'FREQ=DAILY', time: '07:00', mode: 'SHARED', ...over };
      return c.query(
        `INSERT INTO schedules (id, tenant_id, code, route_id, recurrence, departure_local_time, timezone, service_mode, valid_from)
         VALUES (gen_random_uuid(), $1, 'DB-S', $2, $3, $4, 'America/Lima', $5, $6)`,
        [a.id, route2, v.recurrence, v.time, v.mode, day(1)],
      );
    };
    for (const over of [
      { recurrence: 'FREQ=MONTHLY' },
      { recurrence: 'FREQ=WEEKLY;BYDAY=' },
      { recurrence: 'FREQ=WEEKLY;BYDAY=XX' },
      { time: '7:00' },
      { mode: 'PRIVATE' },
    ]) {
      await rejects((c) => insertSchedule(c, over), '23514');
    }
    for (const sql of [
      `UPDATE schedules SET code = 'OTRO' WHERE id = $1`,
      `UPDATE schedules SET route_id = route_id WHERE id = $1`,
      `UPDATE schedules SET timezone = 'UTC' WHERE id = $1`,
      `DELETE FROM schedules WHERE id = $1`,
      `UPDATE trips SET schedule_id = NULL, departure_date = NULL WHERE schedule_id = $1`,
    ]) {
      await rejects((c) => c.query(sql, [daily]), '42501');
    }
  });

  it('aislamiento: otra empresa no ve, edita ni genera las programaciones de esta (404), ni por RLS', async () => {
    expect(
      (await as(b, 'get', '/api/v1/schedules')).body.schedules.map((s: { code: string }) => s.code),
    ).toEqual(['B-DIARIO']);
    expect((await as(b, 'get', `/api/v1/schedules/${weekly}`)).status).toBe(404);
    expect((await generate(b, weekly)).status).toBe(404);
    expect((await as(b, 'post', `/api/v1/schedules/${weekly}/archive`)).status).toBe(404);
    expectError(
      await as(b, 'post', '/api/v1/schedules', schedule({ code: 'AJENA', vehicleId: null })),
      400,
      'La ruta no es de la empresa',
    );
    expect((await as(a, 'get', '/api/v1/schedules/no-es-un-id')).status).toBe(404);
    expect(
      await inTenant(
        b,
        async (c) =>
          (await c.query('SELECT count(*)::int AS n FROM schedules WHERE id = $1', [weekly])).rows[0].n,
      ),
    ).toBe(0);
    const pool = testPool('app', DB, 1);
    try {
      expect((await pool.query('SELECT count(*)::int AS n FROM schedules')).rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('permisos: sin trips.manage → 403; sin sesión → 401; suspendida consulta pero no genera', async () => {
    const userId = (
      await seed.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), 'cajera@prog-a.pe', 'x', 'Cajera', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0]?.id as string;
    await seed.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [a.id, userId],
    );
    expect((await as(a, 'get', '/api/v1/schedules', undefined, userId)).status).toBe(403);
    expect((await as(a, 'post', `/api/v1/schedules/${weekly}/generate`, undefined, userId)).status).toBe(403);
    expect((await http().get('/api/v1/schedules').set('Host', a.host)).status).toBe(401);
    const to = (status: string) =>
      asStaff('post', `/api/v1/platform/tenants/${a.id}/status`, { to: status, reason: 'Prueba 7.3b' });
    expect((await to('PAST_DUE')).status).toBe(200);
    expect((await to('SUSPENDED')).status).toBe(200);
    try {
      expect((await as(a, 'get', `/api/v1/schedules/${weekly}`)).status).toBe(200);
      expect((await generate(a, weekly)).status).toBe(403);
      expect(
        (await as(a, 'post', '/api/v1/schedules', schedule({ code: 'SUSP', vehicleId: null }))).status,
      ).toBe(403);
    } finally {
      expect((await to('ACTIVE')).status).toBe(200);
    }
  });
});
