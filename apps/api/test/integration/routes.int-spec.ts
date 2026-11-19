/**
 * Fase 7.1 · Rutas y paradas (data-dictionary §5; F7-Q7 y F7-Q9). PostgreSQL y Redis reales: paradas en orden
 * sobre ubicaciones activas de la empresa, minutos y km, trazas que empiezan y terminan en sus paradas, importación
 * de GPX y KML, avisos de una ruta fluvial, archivar, reglas de la base (trigger diferido y privilegios),
 * aislamiento entre empresas (RLS), permisos y estados del tenant.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
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

/** Traza Pucallpa → Contamana por el Ucayali (4 puntos). */
const UCAYALI = [
  [-74.5539, -8.3791],
  [-74.7, -8.0],
  [-74.9, -7.6],
  [-75.0094, -7.3352],
];

describe('Fase 7.1 · rutas y paradas', () => {
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
  /** Sube un archivo de traza como cuerpo crudo, con su tipo. */
  const upload = async (c: Company, body: string | Buffer, type = 'application/gpx+xml') =>
    http()
      .post('/api/v1/routes/traces/import')
      .set('Host', c.host)
      .set('Cookie', await cookie(c))
      .set('X-CSRF-Token', CSRF)
      .set('Content-Type', type)
      .send(body);
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
    stop('pucallpa', 0, { pathToNext: UCAYALI, allowsAlighting: false }),
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
    staff = (await seedPlatformSession(seed, { email: 'rutas@yebo.pe', role: 'SUPERADMIN', now: new Date() }))
      .cookie;
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
    a = await company('rutas-a', v.body.id);
    b = await company('rutas-b', v.body.id);
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

  let routeId = '';

  it('crear: paradas en orden, km por la traza o en línea recta, y aviso de una parada fluvial que no es puerto', async () => {
    const created = await as(a, 'post', '/api/v1/routes', {
      code: ' pcl-iqt ',
      name: ' Pucallpa – Iquitos ',
      modality: 'RIVER',
      stops: amazonas(),
    });
    expect(created.status).toBe(201);
    routeId = created.body.id;
    expect(created.body).toMatchObject({
      code: 'PCL-IQT',
      name: 'Pucallpa – Iquitos',
      modality: 'RIVER',
      archived: false,
      // Valores calculados a mano (haversine) para estas coordenadas.
      totalKm: 721.54,
      warnings: ['Iquitos no es puerto ni embarcadero'],
    });
    expect(
      created.body.stops.map((s: Record<string, unknown>) => [
        s.seq,
        s.locationName,
        s.offsetMinutes,
        s.dwellMinutes,
        s.allowsBoarding,
        s.allowsAlighting,
        s.kmToNext,
        s.kmFromOrigin,
      ]),
    ).toEqual([
      [0, 'Pucallpa', 0, 0, true, false, 126.57, 0], // por la traza del Ucayali
      [1, 'Contamana', 720, 60, true, true, 199.5, 126.57], // línea recta
      [2, 'Yurimaguas', 2160, 120, true, true, 395.47, 326.07],
      [3, 'Iquitos', 5040, 0, false, true, null, 721.54],
    ]);
    expect(created.body.stops[0].pathToNext).toEqual(UCAYALI);
    expect(created.body.stops[0]).toMatchObject({ locationKind: 'PORT', lat: -8.3791, lng: -74.5539 });

    const list = await as(a, 'get', '/api/v1/routes');
    expect(list.status).toBe(200);
    expect(list.body.routes).toEqual([created.body]);
    expect((await as(a, 'get', `/api/v1/routes/${routeId}`)).body).toEqual(created.body);
  });

  it('validación: reglas de las paradas (400), código único (409) y modalidad que la empresa opera', async () => {
    const post = (over: object) =>
      as(a, 'post', '/api/v1/routes', {
        code: 'X-1',
        name: 'Prueba',
        modality: 'RIVER',
        stops: amazonas(),
        ...over,
      });
    expect((await post({ code: 'pcl-iqt' })).status).toBe(409);
    for (const stops of [
      [stop('pucallpa', 0)],
      [stop('pucallpa', 10), stop('iquitos', 600)],
      [stop('pucallpa', 0), stop('contamana', 600, { dwellMinutes: 60 }), stop('iquitos', 650)],
      [stop('pucallpa', 0), stop('pucallpa', 600)],
      [stop('pucallpa', 0), stop('iquitos', 600, { allowsAlighting: false })],
    ]) {
      expect((await post({ stops })).status).toBe(400);
    }
    const land = await post({ modality: 'LAND' });
    expect(land.status).toBe(400);
    expect(land.body.error.message).toBe('La empresa no opera servicios de transporte terrestre');
    // Ida y vuelta: la misma ubicación, pero no seguidas.
    const roundTrip = await post({
      code: 'PCL-CTM-PCL',
      stops: [stop('pucallpa', 0), stop('contamana', 720), stop('pucallpa', 1440)],
    });
    expect(roundTrip.status).toBe(201);
    expect(roundTrip.body.totalKm).toBe(252.92); // 126,46 km en línea recta, ida y vuelta
  });

  it('trazas: solo entre paradas ubicadas en el mapa y con los extremos a ≤ 5 km de sus paradas', async () => {
    const post = (stops: object[]) =>
      as(a, 'post', '/api/v1/routes', { code: 'TRAZA', name: 'Traza', modality: 'RIVER', stops });
    const far = await post([
      stop('pucallpa', 0, {
        pathToNext: [
          [-74.4939, -8.3791], // 6,6 km al este de Pucallpa
          [-75.0094, -7.3352],
        ],
      }),
      stop('contamana', 600),
    ]);
    expect(far.status).toBe(400);
    expect(far.body.error.message).toBe(
      'Tramo Pucallpa → Contamana: la traza empieza a 6,6 km de Pucallpa (máximo 5 km)',
    );
    const farEnd = await post([
      stop('pucallpa', 0, { pathToNext: [UCAYALI[0], [-75.0094, -7.25]] }),
      stop('contamana', 600),
    ]);
    expect(farEnd.body.error.message).toBe(
      'Tramo Pucallpa → Contamana: la traza termina a 9,5 km de Contamana (máximo 5 km)',
    );
    const unplaced = await post([
      stop('contamana', 0, { pathToNext: [UCAYALI[3], [-73.9, -5.0]] }),
      stop('requena', 600),
    ]);
    expect(unplaced.status).toBe(400);
    expect(unplaced.body.error.message).toBe(
      'Tramo Contamana → Requena: ubica Requena en el mapa antes de trazar el tramo',
    );
    // Sin traza, una parada sin coordenadas deja los km sin medir (null), pero se guarda.
    const ok = await post([stop('contamana', 0), stop('requena', 600)]);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ totalKm: null, warnings: [] });
    expect(ok.body.stops.map((s: { kmToNext: number | null }) => s.kmToNext)).toEqual([null, null]);
    // Fuera del Perú: lo rechaza el esquema.
    expect(
      (
        await post([
          stop('pucallpa', 0, { pathToNext: [UCAYALI[0], [-74.07, 4.71]] }),
          stop('contamana', 600),
        ])
      ).status,
    ).toBe(400);
  });

  it('editar: reemplaza las paradas y el nombre; el código y la modalidad no cambian; archivada no se edita', async () => {
    const edited = await as(a, 'put', `/api/v1/routes/${routeId}`, {
      name: 'Pucallpa – Yurimaguas',
      stops: [stop('pucallpa', 0, { pathToNext: UCAYALI }), stop('contamana', 720), stop('yurimaguas', 2000)],
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ code: 'PCL-IQT', name: 'Pucallpa – Yurimaguas', warnings: [] });
    expect(edited.body.stops.map((s: { locationName: string }) => s.locationName)).toEqual([
      'Pucallpa',
      'Contamana',
      'Yurimaguas',
    ]);
    const rows = await seed.query('SELECT seq FROM route_stops WHERE route_id = $1 ORDER BY seq', [routeId]);
    expect(rows.rows.map((r) => r.seq)).toEqual([0, 1, 2]);
    for (const extra of [{ code: 'OTRO' }, { modality: 'LAND' }]) {
      const res = await as(a, 'put', `/api/v1/routes/${routeId}`, {
        name: 'Otra',
        stops: amazonas(),
        ...extra,
      });
      expect(res.status).toBe(400);
    }
    expect(
      (await as(a, 'put', `/api/v1/routes/${routeId}`, { name: 'Pucallpa – Iquitos', stops: amazonas() }))
        .status,
    ).toBe(200);
  });

  it('archivar: una ubicación no se archiva mientras sea parada de una ruta activa; restaurar exige ubicaciones activas', async () => {
    const blocked = await as(a, 'post', `/api/v1/locations/${loc.iquitos}/archive`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toBe(
      'La ubicación es parada de la ruta activa PCL-IQT: archívalas o cámbialas antes',
    );
    expect((await as(a, 'post', `/api/v1/routes/${routeId}/archive`)).body.archived).toBe(true);
    // Archivada, no se edita.
    expect(
      (await as(a, 'put', `/api/v1/routes/${routeId}`, { name: 'Otra', stops: amazonas() })).status,
    ).toBe(409);
    expect((await as(a, 'post', `/api/v1/locations/${loc.iquitos}/archive`)).status).toBe(200);
    // Una ruta nueva no va a una ubicación archivada, y la archivada no se restaura con ella.
    const toArchived = await as(a, 'post', '/api/v1/routes', {
      code: 'YMS-IQT',
      name: 'Yurimaguas – Iquitos',
      modality: 'RIVER',
      stops: [stop('yurimaguas', 0), stop('iquitos', 600)],
    });
    expect(toArchived.status).toBe(400);
    expect(toArchived.body.error.message).toBe('La ubicación Iquitos está archivada');
    expect((await as(a, 'post', `/api/v1/routes/${routeId}/restore`)).status).toBe(400);
    expect((await as(a, 'post', `/api/v1/locations/${loc.iquitos}/restore`)).status).toBe(200);
    const restored = await as(a, 'post', `/api/v1/routes/${routeId}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.archived).toBe(false);
  });

  it('importar: GPX y KML devuelven la traza sin guardar nada; DOCTYPE, otros formatos y JSON → 400', async () => {
    const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>${UCAYALI.map(
      ([lng, lat]) => `<trkpt lat="${lat}" lon="${lng}"/>`,
    ).join('')}</trkseg></trk></gpx>`;
    const r = await upload(a, gpx);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ format: 'GPX', points: UCAYALI, sourcePoints: 4, km: 126.57 });

    const kml = `<kml><Placemark><LineString><coordinates>${UCAYALI.map((p) => p.join(',')).join(
      ' ',
    )}</coordinates></LineString></Placemark></kml>`;
    for (const type of ['application/vnd.google-earth.kml+xml', 'application/xml', 'text/xml']) {
      const k = await upload(a, kml, type);
      expect(k.status).toBe(200);
      expect(k.body.format).toBe('KML');
    }
    const xxe = await upload(a, `<!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]><gpx>&x;</gpx>`);
    expect(xxe.status).toBe(400);
    expect(xxe.body.error.message).toBe('El archivo declara un DOCTYPE o entidades, y no se admiten');
    expect((await as(a, 'post', '/api/v1/routes/traces/import', { gpx })).status).toBe(400);
    expect((await upload(a, Buffer.from('%PDF-1.7'), 'application/pdf')).status).toBe(400);
    const routes = (await as(a, 'get', '/api/v1/routes')).body.routes;
    expect(routes).toHaveLength(3);
  });

  it('reglas de la base: la ruta entera se comprueba al confirmar (trigger diferido); código y modalidad fijos; sin borrar rutas', async () => {
    const insertRoute = async (c: PoolClient, code: string) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO routes (id, tenant_id, code, name, modality) VALUES (gen_random_uuid(), $1, $2, 'Directa', 'RIVER')
           RETURNING id`,
          [a.id, code],
        )
      ).rows[0]?.id as string;
    const insertStop = (
      c: PoolClient,
      route: string,
      seq: number,
      location: string,
      offset: number,
      extra = '',
    ) =>
      c.query(
        `INSERT INTO route_stops (id, tenant_id, route_id, seq, location_id, offset_minutes, dwell_minutes,
                                  allows_boarding, allows_alighting, path_to_next)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 0, true, true, ${extra || 'NULL'})`,
        [a.id, route, seq, location, offset],
      );
    const commitFails = async (build: (c: PoolClient) => Promise<void>, message: string) => {
      await expect(inTenant(a, build, true)).rejects.toMatchObject({
        code: 'P0001',
        message: `route_stops: ${message}`,
      });
    };
    await commitFails(async (c) => {
      await insertStop(c, await insertRoute(c, 'DB-1'), 0, loc.pucallpa, 0);
    }, 'una ruta tiene al menos origen y destino');
    await commitFails(async (c) => {
      const r = await insertRoute(c, 'DB-2');
      await insertStop(c, r, 0, loc.pucallpa, 0);
      await insertStop(c, r, 2, loc.iquitos, 600);
    }, 'las paradas van de 0 a n-1, sin huecos');
    await commitFails(async (c) => {
      const r = await insertRoute(c, 'DB-3');
      await insertStop(c, r, 0, loc.pucallpa, 0);
      await insertStop(c, r, 1, loc.contamana, 600);
      await insertStop(c, r, 2, loc.iquitos, 500);
    }, 'cada parada llega después de salir de la anterior');
    await commitFails(async (c) => {
      const r = await insertRoute(c, 'DB-4');
      await insertStop(c, r, 0, loc.pucallpa, 0);
      await insertStop(c, r, 1, loc.iquitos, 600, `'[[-73.2,-3.7],[-73.3,-3.8]]'`);
    }, 'el destino permite bajar y no tiene traza');
    await commitFails(async (c) => {
      const r = await insertRoute(c, 'DB-5');
      await insertStop(c, r, 0, loc.pucallpa, 0);
      await insertStop(c, r, 1, loc.pucallpa, 600);
    }, 'dos paradas seguidas no son la misma ubicación');
    // Borrar todas las paradas de una ruta existente tampoco se confirma.
    await commitFails(async (c) => {
      await c.query('DELETE FROM route_stops WHERE route_id = $1', [routeId]);
    }, 'una ruta tiene al menos origen y destino');
    // Una ruta válida sí se confirma (y luego se archiva para no estorbar).
    await inTenant(
      a,
      async (c) => {
        const r = await insertRoute(c, 'DB-OK');
        await insertStop(c, r, 0, loc.pucallpa, 0);
        await insertStop(c, r, 1, loc.contamana, 600);
        await c.query('UPDATE routes SET archived_at = now() WHERE id = $1', [r]);
      },
      true,
    );
    // CHECK por fila y privilegios.
    for (const [sql, code] of [
      [`UPDATE routes SET code = 'OTRO' WHERE id = $1`, '42501'],
      [`UPDATE routes SET modality = 'LAND' WHERE id = $1`, '42501'],
      [`DELETE FROM routes WHERE id = $1`, '42501'],
      [`UPDATE route_stops SET offset_minutes = 1 WHERE route_id = $1`, '42501'],
      [`UPDATE routes SET name = ' con espacios ' WHERE id = $1`, '23514'],
    ] as const) {
      await expect(inTenant(a, (c) => c.query(sql, [routeId]))).rejects.toMatchObject({ code });
    }
    await expect(
      inTenant(a, (c) => insertStop(c, routeId, 9, loc.pucallpa, 0, `'{"type":"LineString"}'`)),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('aislamiento: otra empresa no ve ni usa las rutas ni las ubicaciones de esta (404 o 400), ni por RLS', async () => {
    expect((await as(b, 'get', '/api/v1/routes')).body.routes).toEqual([]);
    expect((await as(b, 'get', `/api/v1/routes/${routeId}`)).status).toBe(404);
    const put = await as(b, 'put', `/api/v1/routes/${routeId}`, { name: 'Otra', stops: amazonas() });
    expect([put.status, put.body.error?.message]).toEqual([404, 'Recurso no encontrado']);
    expect((await as(b, 'post', `/api/v1/routes/${routeId}/archive`)).status).toBe(404);
    const foreign = await as(b, 'post', '/api/v1/routes', {
      code: 'AJENA',
      name: 'Con paradas de otra empresa',
      modality: 'RIVER',
      stops: amazonas(),
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.message).toBe('Una de las paradas no es una ubicación de la empresa');
    expect((await as(a, 'get', '/api/v1/routes/no-es-un-id')).status).toBe(404);
    const counts = await inTenant(b, async (c) => [
      (await c.query('SELECT count(*)::int AS n FROM routes')).rows[0].n,
      (await c.query('SELECT count(*)::int AS n FROM route_stops')).rows[0].n,
    ]);
    expect(counts).toEqual([0, 0]);
    const pool = testPool('app', DB, 1);
    try {
      expect((await pool.query('SELECT count(*)::int AS n FROM routes')).rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('permisos: sin routes.manage → 403; sin sesión → 401; empresa suspendida consulta pero no configura', async () => {
    const userId = (
      await seed.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), 'cajera@rutas-a.pe', 'x', 'Cajera', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0]?.id as string;
    await seed.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [a.id, userId],
    );
    expect((await as(a, 'get', '/api/v1/routes', undefined, userId)).status).toBe(403);
    expect((await as(a, 'post', `/api/v1/routes/${routeId}/archive`, undefined, userId)).status).toBe(403);
    expect((await http().get('/api/v1/routes').set('Host', a.host)).status).toBe(401);

    const to = (status: string) =>
      asStaff('post', `/api/v1/platform/tenants/${a.id}/status`, { to: status, reason: 'Prueba 7.1' });
    expect((await to('PAST_DUE')).status).toBe(200);
    expect((await to('SUSPENDED')).status).toBe(200);
    try {
      expect((await as(a, 'get', '/api/v1/routes')).status).toBe(200);
      expect(
        (await as(a, 'put', `/api/v1/routes/${routeId}`, { name: 'Otra', stops: amazonas() })).status,
      ).toBe(403);
      expect((await as(a, 'post', `/api/v1/routes/${routeId}/archive`)).status).toBe(403);
      expect((await upload(a, '<gpx/>')).status).toBe(403);
    } finally {
      expect((await to('ACTIVE')).status).toBe(200);
    }
  });
});
