/**
 * Fase 6.3 · Layouts (data-dictionary §4; capacity-and-inventory §2–4; F6-Q1). PostgreSQL y Redis reales: borrador
 * guardado a medias, publicación con todas las reglas y materialización en zonas, elementos y reglas de capacidad
 * inmutables, varias versiones publicadas, asignación por fechas sin solapamiento (exclusión), aislamiento, permisos y
 * reglas de la base.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { boatTemplate, busTemplate, emptyLayout, seatRows, type LayoutDocument } from '@yebo/contracts';
import type { Pool } from 'pg';
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

const day = (offset: number) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
};

describe('Fase 6.3 · layouts', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let staff = '';
  let a: Company; // fluvial (pasajeros, encomiendas y carga) y terrestre (pasajeros)
  let b: Company; // solo pasajeros fluviales

  const http = () => request(app.getHttpServer());
  const asStaff = (method: 'get' | 'post', path: string, body?: object) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', staff);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  const as = async (c: Company, method: Method, path: string, body?: object, userId = c.adminUserId) => {
    const sessions = app.get(SessionService);
    const identity = (await sessions.createIdentitySession({ userId, authMethods: ['pwd'] })).id;
    const token = (await sessions.openTenantSession({ identitySessionId: identity, host: c.host }))
      .accessToken;
    const agent = http();
    let req = agent[method](path)
      .set('Host', c.host)
      .set('Cookie', `__Host-yebo_at=${token}; __Host-yebo_csrf=${CSRF}`);
    if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
    return body ? req.send(body) : req;
  };
  const company = async (slug: string, planVersionId: string, services: object[]): Promise<Company> => {
    const created = await asStaff('post', '/api/v1/platform/tenants', {
      slug,
      legalName: `${slug} SAC`,
      tradeName: `Empresa ${slug}`,
      taxIdType: 'RUC',
      taxId: `20${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      planVersionId,
      services,
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
  /** Un tipo y un vehículo de la empresa, por la API de flota. */
  const vehicle = async (c: Company, modality: 'LAND' | 'RIVER', code: string, typeName: string) => {
    const types = (await as(c, 'get', '/api/v1/vehicle-types')).body.types as { id: string; name: string }[];
    const typeId =
      types.find((t) => t.name === typeName)?.id ??
      (await as(c, 'post', '/api/v1/vehicle-types', { name: typeName, modality, catalogCode: null })).body.id;
    const created = await as(c, 'post', '/api/v1/vehicles', {
      code,
      name: code,
      vehicleTypeId: typeId,
      registration: `${code}-001`,
      status: 'ACTIVE',
      ownership: 'OWN',
      nominalCapacity: { passengers: null, weightKg: null, volumeM3: null },
      features: [],
    });
    expect(created.status).toBe(201);
    return { id: created.body.id as string, typeId: typeId as string };
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
      await seedPlatformSession(seed, { email: 'layouts@yebo.pe', role: 'SUPERADMIN', now: new Date() })
    ).cookie;
    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'layouts', name: 'Layouts' });
    const v = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
      basePrice: '99.00',
      billingInterval: 'MONTHLY',
      includedUsers: 5,
      extraUserPrice: '15.00',
      trialDays: 0,
      modules: ['PASSENGERS'],
    });
    await asStaff('post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
    a = await company('layouts-a', v.body.id, [
      { modality: 'RIVER', service: 'PASSENGER' },
      { modality: 'RIVER', service: 'PARCEL' },
      { modality: 'RIVER', service: 'CARGO' },
      { modality: 'LAND', service: 'PASSENGER' },
    ]);
    b = await company('layouts-b', v.body.id, [{ modality: 'RIVER', service: 'PASSENGER' }]);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  let boatId = '';
  let lancha: { id: string; typeId: string };

  it('crear: el borrador nace vacío o con una plantilla, con lo que le falta para publicar y su inventario', async () => {
    const empty = await as(a, 'post', '/api/v1/layouts', {
      name: 'Borrador vacío',
      modality: 'LAND',
      vehicleTypeId: null,
      document: null,
    });
    expect(empty.status).toBe(201);
    expect(empty.body).toMatchObject({ version: 1, status: 'DRAFT', document: emptyLayout('LAND') });
    expect(empty.body.issues).toEqual([{ path: 'zones', message: 'Añade al menos una zona con capacidad' }]);

    const boat = await as(a, 'post', '/api/v1/layouts', {
      name: 'Lancha 110',
      modality: 'RIVER',
      vehicleTypeId: null,
      document: boatTemplate(),
    });
    expect(boat.status).toBe(201);
    expect(boat.body.issues).toEqual([]);
    expect(boat.body.inventory.summary).toMatchObject({
      beds: 8,
      cabins: 4,
      pooledPersons: 70,
      totalPersons: 110,
    });
    boatId = boat.body.layoutId;

    // Nombre repetido → 409; modalidad que la empresa no opera → 400; tipo de otra modalidad → 400.
    expect(
      (
        await as(a, 'post', '/api/v1/layouts', {
          name: 'Lancha 110',
          modality: 'RIVER',
          vehicleTypeId: null,
          document: null,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await as(b, 'post', '/api/v1/layouts', {
          name: 'Bus',
          modality: 'LAND',
          vehicleTypeId: null,
          document: null,
        })
      ).status,
    ).toBe(400);
    lancha = await vehicle(a, 'RIVER', 'LANCHA-01', 'Lancha');
    expect(
      (
        await as(a, 'post', '/api/v1/layouts', {
          name: 'X',
          modality: 'LAND',
          vehicleTypeId: lancha.typeId,
          document: null,
        })
      ).status,
    ).toBe(400);
    // El documento se valida en forma (estricto): un campo desconocido → 400.
    expect(
      (
        await as(a, 'post', '/api/v1/layouts', {
          name: 'Raro',
          modality: 'RIVER',
          vehicleTypeId: null,
          document: { ...boatTemplate(), css: 'x' },
        })
      ).status,
    ).toBe(400);
  });

  it('borrador a medias se guarda; publicar exige las reglas (400 con el motivo) y materializa la versión', async () => {
    // La zona libre sin su capacidad: se guarda, pero no se publica.
    const broken: LayoutDocument = {
      ...boatTemplate(),
      zones: boatTemplate().zones.map((z) => (z.code === 'LIBRE' ? { ...z, capacity: [] } : z)),
    };
    const saved = await as(a, 'put', `/api/v1/layouts/${boatId}/draft`, { document: broken });
    expect(saved.status).toBe(200);
    expect(saved.body.issues.map((i: { message: string }) => i.message)).toEqual([
      'La zona LIBRE necesita su capacidad (personas)',
    ]);
    const refused = await as(a, 'post', `/api/v1/layouts/${boatId}/publish`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe(
      'No se puede publicar: hay un dato por corregir. La zona LIBRE necesita su capacidad (personas)',
    );

    await as(a, 'put', `/api/v1/layouts/${boatId}/draft`, { document: boatTemplate() });
    const published = await as(a, 'post', `/api/v1/layouts/${boatId}/publish`);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ version: 1, status: 'PUBLISHED', issues: [] });
    expect((await as(a, 'post', `/api/v1/layouts/${boatId}/publish`)).status).toBe(409); // ya no hay borrador

    // Materializada: 6 zonas, 49 elementos (rótulo, 4 camarotes, 8 camas y 36 asientos), 6 reglas y el aforo.
    const rows = await seed.query<{ zones: number; elements: number; rules: number; total: number }>(
      `SELECT (SELECT count(*)::int FROM layout_zones z WHERE z.layout_version_id = v.id) AS zones,
              (SELECT count(*)::int FROM layout_elements e WHERE e.layout_version_id = v.id) AS elements,
              (SELECT count(*)::int FROM capacity_rules r JOIN layout_zones z ON z.id = r.zone_id
                WHERE z.layout_version_id = v.id) AS rules,
              v.total_persons AS total
         FROM layout_versions v WHERE v.layout_id = $1 AND v.version = 1`,
      [boatId],
    );
    expect(rows.rows).toEqual([{ zones: 6, elements: 49, rules: 6, total: 110 }]);
    const elements = await seed.query<{
      code: string;
      assignable: boolean;
      unit: boolean;
      parent: string | null;
      price: string | null;
    }>(
      `SELECT e.code, e.is_assignable AS assignable, e.sellable_as_unit AS unit, p.code AS parent,
              e.price_class_code AS price
         FROM layout_elements e LEFT JOIN layout_elements p ON p.id = e.parent_element_id
         JOIN layout_versions v ON v.id = e.layout_version_id
        WHERE v.layout_id = $1 AND e.code IN ('C1', 'C1-B1', 'PROA') ORDER BY e.code`,
      [boatId],
    );
    expect(elements.rows).toEqual([
      { code: 'C1', assignable: false, unit: true, parent: null, price: 'CAMAROTE' },
      { code: 'C1-B1', assignable: true, unit: false, parent: 'C1', price: 'CAMA' },
      { code: 'PROA', assignable: false, unit: false, parent: null, price: null },
    ]);
  });

  it('publicar exige que la empresa opere el servicio de cada zona en la modalidad del layout', async () => {
    const created = await as(b, 'post', '/api/v1/layouts', {
      name: 'Lancha de B',
      modality: 'RIVER',
      vehicleTypeId: null,
      document: boatTemplate(),
    });
    const refused = await as(b, 'post', `/api/v1/layouts/${created.body.layoutId}/publish`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/hay 2 datos por corregir/);
    expect(refused.body.error.message).toMatch(/no opera carga en esta modalidad \(zona CUBIERTA\)/);
    expect(refused.body.error.message).toMatch(/no opera encomiendas en esta modalidad \(zona BODEGA\)/);
  });

  it('una nueva versión no toca la publicada; varias versiones publicadas conviven', async () => {
    const doc = { ...boatTemplate(), totalPersons: 65 };
    const draft = await as(a, 'put', `/api/v1/layouts/${boatId}/draft`, { document: doc });
    expect(draft.body).toMatchObject({ version: 2, status: 'DRAFT' });
    expect((await as(a, 'get', `/api/v1/layouts/${boatId}/versions/1`)).body.document.totalPersons).toBe(110);
    expect((await as(a, 'post', `/api/v1/layouts/${boatId}/publish`)).body).toMatchObject({
      version: 2,
      status: 'PUBLISHED',
    });
    const list = (await as(a, 'get', '/api/v1/layouts')).body.layouts.find(
      (l: { id: string }) => l.id === boatId,
    );
    expect(list.versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([
      [2, 'PUBLISHED'],
      [1, 'PUBLISHED'],
    ]);
    expect((await as(a, 'get', `/api/v1/layouts/${boatId}/versions/9`)).status).toBe(404);
  });

  it('Fase 6.4a: hasta 6 pisos con medidas reales; zona de pasajeros mixta en el último piso', async () => {
    const base = boatTemplate();
    const decks = [0, 1, 2, 3, 4, 5].map((index) => ({
      index,
      name: `Piso ${index + 1}`,
      lengthM: 9,
      widthM: 5,
    }));
    const doc: LayoutDocument = {
      ...base,
      decks,
      zones: [
        ...base.zones.filter((z) => z.kind !== 'CARGO_DECK' && z.kind !== 'HOLD'),
        { ...base.zones.find((z) => z.code === 'ASIENTOS')!, code: 'ALTO', name: 'Piso alto', deck: 5 },
      ],
      elements: [
        ...base.elements.filter((e) => e.deck <= 2 && e.y < 18),
        ...seatRows({
          cellCm: 50,
          zoneCode: 'ALTO',
          deck: 5,
          x: 1,
          y: 3,
          rows: 2,
          layout: [2, 3],
          firstRow: 20,
        }),
      ],
    };
    // Los camarotes del piso 1 y la zona libre caben en 9 m de largo: solo se recortan zonas por cantidad.
    doc.zones = doc.zones.map((z) => (z.code === 'LIBRE' ? { ...z, rect: { ...z.rect, h: 6 } } : z));
    const created = await as(a, 'post', '/api/v1/layouts', {
      name: 'Lancha de 6 pisos',
      modality: 'RIVER',
      vehicleTypeId: null,
      document: doc,
    });
    expect(created.status).toBe(201);
    expect(created.body.issues).toEqual([]);
    expect((await as(a, 'post', `/api/v1/layouts/${created.body.layoutId}/publish`)).body).toMatchObject({
      status: 'PUBLISHED',
    });
    const { rows } = await seed.query(
      `SELECT v.decks, max(e.deck)::int AS top FROM layout_versions v JOIN layout_elements e ON e.layout_version_id = v.id
        WHERE v.layout_id = $1::uuid GROUP BY v.decks`,
      [created.body.layoutId],
    );
    expect(rows).toEqual([{ decks: 6, top: 5 }]);

    // Siete pisos o una medida que no es múltiplo de 25 cm: 400 del esquema.
    for (const bad of [
      { ...doc, decks: [...decks, { index: 6, name: 'Piso 7', lengthM: 9, widthM: 5 }] },
      { ...doc, decks: decks.map((d) => (d.index === 0 ? { ...d, widthM: 5.1 } : d)) },
    ]) {
      expect(
        (
          await as(a, 'post', '/api/v1/layouts', {
            name: 'Mal',
            modality: 'RIVER',
            vehicleTypeId: null,
            document: bad,
          })
        ).status,
      ).toBe(400);
    }
  });

  it('asignar: versión publicada, misma modalidad (y tipo), sin solaparse; terminar y encadenar', async () => {
    const path = `/api/v1/vehicles/${lancha.id}/layout-assignments`;
    const first = await as(a, 'post', path, {
      layoutId: boatId,
      version: 1,
      validFrom: day(0),
      validTo: null,
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      layoutName: 'Lancha 110',
      version: 1,
      validFrom: day(0),
      validTo: null,
    });

    const clash = await as(a, 'post', path, {
      layoutId: boatId,
      version: 2,
      validFrom: day(10),
      validTo: null,
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toBe('El vehículo ya tiene un layout asignado en esas fechas');
    const ended = await as(a, 'post', `${path}/${first.body.id}/end`, { validTo: day(10) });
    expect(ended.body.validTo).toBe(day(10));
    expect((await as(a, 'post', `${path}/${first.body.id}/end`, { validTo: day(0) })).status).toBe(400);
    expect(
      (await as(a, 'post', path, { layoutId: boatId, version: 2, validFrom: day(10), validTo: null })).status,
    ).toBe(201);
    expect(
      (await as(a, 'get', path)).body.assignments.map((x: { version: number; validFrom: string }) => [
        x.version,
        x.validFrom,
      ]),
    ).toEqual([
      [2, day(10)],
      [1, day(0)],
    ]);

    // Otra modalidad, otro tipo, un borrador o un vehículo retirado: no.
    const bus = await vehicle(a, 'LAND', 'BUS-01', 'Bus');
    const busLayout = await as(a, 'post', '/api/v1/layouts', {
      name: 'Bus 40',
      modality: 'LAND',
      vehicleTypeId: bus.typeId,
      document: busTemplate(),
    });
    expect(
      (
        await as(a, 'post', `/api/v1/vehicles/${bus.id}/layout-assignments`, {
          layoutId: boatId,
          version: 1,
          validFrom: day(0),
          validTo: null,
        })
      ).body.error.message,
    ).toBe('El layout es de otra modalidad que el vehículo');
    expect(
      (
        await as(a, 'post', `/api/v1/vehicles/${bus.id}/layout-assignments`, {
          layoutId: busLayout.body.layoutId,
          version: 1,
          validFrom: day(0),
          validTo: null,
        })
      ).body.error.message,
    ).toBe('Solo se asigna una versión publicada');
    await as(a, 'post', `/api/v1/layouts/${busLayout.body.layoutId}/publish`);
    const otherBus = await vehicle(a, 'LAND', 'MINI-01', 'Minibús');
    expect(
      (
        await as(a, 'post', `/api/v1/vehicles/${otherBus.id}/layout-assignments`, {
          layoutId: busLayout.body.layoutId,
          version: 1,
          validFrom: day(0),
          validTo: null,
        })
      ).body.error.message,
    ).toBe('El layout es para otro tipo de vehículo');
    expect(
      (
        await as(a, 'post', `/api/v1/vehicles/${bus.id}/layout-assignments`, {
          layoutId: busLayout.body.layoutId,
          version: 1,
          validFrom: day(0),
          validTo: null,
        })
      ).status,
    ).toBe(201);
  });

  it('no se archiva una versión ni un layout en uso hoy o después; sí una versión sin uso', async () => {
    expect((await as(a, 'post', `/api/v1/layouts/${boatId}/versions/1/archive`)).status).toBe(409);
    expect((await as(a, 'post', `/api/v1/layouts/${boatId}/archive`)).status).toBe(409);
    // Una tercera versión, publicada y sin asignar, se archiva; una archivada no se asigna.
    await as(a, 'put', `/api/v1/layouts/${boatId}/draft`, { document: boatTemplate() });
    await as(a, 'post', `/api/v1/layouts/${boatId}/publish`);
    expect((await as(a, 'post', `/api/v1/layouts/${boatId}/versions/3/archive`)).body.status).toBe(
      'ARCHIVED',
    );
    expect(
      (
        await as(a, 'post', `/api/v1/vehicles/${lancha.id}/layout-assignments`, {
          layoutId: boatId,
          version: 3,
          validFrom: day(100),
          validTo: null,
        })
      ).status,
    ).toBe(400);
  });

  it('reglas de la base: versión publicada inmutable, contenido solo al publicar, un borrador, sin solapamiento', async () => {
    const app_ = testPool('app', DB, 1);
    const c = await app_.connect();
    const inTenant = async (sql: string, params: unknown[] = []) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.id]);
      try {
        return await c.query(sql, params);
      } finally {
        await c.query('ROLLBACK');
      }
    };
    const v1 = (
      await seed.query<{ id: string }>(
        'SELECT id FROM layout_versions WHERE layout_id = $1 AND version = 1',
        [boatId],
      )
    ).rows[0]?.id as string;
    try {
      await expect(
        inTenant(`UPDATE layout_versions SET total_persons = 1 WHERE id = $1`, [v1]),
      ).rejects.toMatchObject({
        code: 'P0001',
      });
      await expect(
        inTenant(`UPDATE layout_versions SET status = 'DRAFT', draft_slot = TRUE WHERE id = $1`, [v1]),
      ).rejects.toMatchObject({
        code: 'P0001',
      });
      await expect(
        inTenant(
          `INSERT INTO layout_zones (id, tenant_id, layout_version_id, code, name, kind, service, allocation_mode, deck, geometry)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'NUEVA', 'Nueva', 'FREE_ZONE', 'PASSENGER', 'POOLED', 0, '{}')`,
          [a.id, v1],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      for (const sql of [
        `UPDATE layout_elements SET capacity = 9 WHERE layout_version_id = $1`,
        `DELETE FROM layout_elements WHERE layout_version_id = $1`,
        `UPDATE capacity_rules SET capacity = 1 WHERE zone_id IN (SELECT id FROM layout_zones WHERE layout_version_id = $1)`,
        `DELETE FROM layout_versions WHERE id = $1`,
        `UPDATE vehicle_layouts SET modality = 'LAND' WHERE id = (SELECT layout_id FROM layout_versions WHERE id = $1)`,
      ]) {
        await expect(inTenant(sql, [v1])).rejects.toMatchObject({ code: '42501' });
      }
      // Dos borradores del mismo layout: el UNIQUE de draft_slot.
      await expect(
        inTenant(
          `INSERT INTO layout_versions (id, tenant_id, layout_id, version, status, draft_slot, schema_version, document,
                                        decks, canvas, updated_at)
           SELECT gen_random_uuid(), tenant_id, layout_id, n, 'DRAFT', TRUE, 1, '{}', 1, '[]', now()
             FROM layout_versions, (VALUES (90), (91)) t(n) WHERE id = $1`,
          [v1],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      // Asignación solapada (exclusión) o de una versión no publicada (trigger).
      await expect(
        inTenant(
          `INSERT INTO vehicle_layout_assignments (id, tenant_id, vehicle_id, layout_version_id, valid_from, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::date, now())`,
          [a.id, lancha.id, v1, day(50)],
        ),
      ).rejects.toMatchObject({ code: '23P01' });
      expect((await c.query('SELECT count(*)::int AS n FROM vehicle_layouts')).rows[0].n).toBe(0); // sin contexto
    } finally {
      c.release();
      await app_.end();
    }
  });

  it('aislamiento, permisos y estados del tenant', async () => {
    expect((await as(b, 'get', `/api/v1/layouts/${boatId}/versions/1`)).status).toBe(404);
    expect((await as(b, 'post', `/api/v1/layouts/${boatId}/publish`)).status).toBe(404);
    const bLancha = await vehicle(b, 'RIVER', 'B-LANCHA', 'Lancha');
    expect(
      (
        await as(b, 'post', `/api/v1/vehicles/${bLancha.id}/layout-assignments`, {
          layoutId: boatId,
          version: 1,
          validFrom: day(0),
          validTo: null,
        })
      ).status,
    ).toBe(400);
    expect((await as(b, 'get', `/api/v1/vehicles/${lancha.id}/layout-assignments`)).status).toBe(404);

    const userId = (
      await seed.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), 'boletero@layouts-a.pe', 'x', 'Boletero', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0]?.id as string;
    await seed.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [a.id, userId],
    );
    expect((await as(a, 'get', '/api/v1/layouts', undefined, userId)).status).toBe(403);

    const to = (status: string) =>
      asStaff('post', `/api/v1/platform/tenants/${a.id}/status`, { to: status, reason: 'Prueba 6.3' });
    expect((await to('PAST_DUE')).status).toBe(200);
    expect((await to('SUSPENDED')).status).toBe(200);
    try {
      expect((await as(a, 'get', '/api/v1/layouts')).status).toBe(200);
      expect(
        (await as(a, 'put', `/api/v1/layouts/${boatId}/draft`, { document: boatTemplate() })).status,
      ).toBe(403);
    } finally {
      expect((await to('ACTIVE')).status).toBe(200);
    }
  });
});
