/**
 * Fase 6.1 · Ubicaciones, sucursales y canales de venta (data-dictionary §2–3; F6-Q4, F6-Q6). PostgreSQL y Redis
 * reales: canal ONLINE desde el alta, mostrador con cada sucursal, archivar en lugar de borrar, reglas de la base,
 * aislamiento entre empresas (RLS), ámbito de sucursal de cada persona, permisos y estados del tenant.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
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

const pucallpa = {
  name: 'Pucallpa',
  kind: 'PORT',
  ubigeo: '250101',
  region: 'Ucayali',
  lat: -8.3791,
  lng: -74.5539,
};
const branchInput = (locationId: string, over: object = {}) => ({
  code: 'pcl-01',
  locationId,
  name: 'Agencia Malecón',
  address: 'Jr. Ucayali 120',
  phones: ['+51 61 571234'],
  isPickupPoint: true,
  isReceptionPoint: true,
  ...over,
});

describe('Fase 6.1 · ubicaciones, sucursales y canales', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let staff = '';
  let a: Company;
  let b: Company;

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
  const company = async (slug: string, planVersionId: string): Promise<Company> => {
    const created = await asStaff('post', '/api/v1/platform/tenants', {
      slug,
      legalName: `${slug} SAC`,
      tradeName: `Empresa ${slug}`,
      taxIdType: 'RUC',
      taxId: `20${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      planVersionId,
      services: [{ modality: 'RIVER', service: 'PASSENGER' }],
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
    staff = (await seedPlatformSession(seed, { email: 'ubic@yebo.pe', role: 'SUPERADMIN', now: new Date() }))
      .cookie;
    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'ubic', name: 'Ubicaciones' });
    const v = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
      basePrice: '99.00',
      billingInterval: 'MONTHLY',
      includedUsers: 5,
      extraUserPrice: '15.00',
      trialDays: 0,
      modules: ['PASSENGERS'],
    });
    await asStaff('post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
    a = await company('ubic-a', v.body.id);
    b = await company('ubic-b', v.body.id);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  let locationId = '';
  let branchId = '';

  it('el alta crea el canal ONLINE de la empresa; el catálogo de tipos es global', async () => {
    const channels = await as(a, 'get', '/api/v1/sales-channels');
    expect(channels.status).toBe(200);
    expect(channels.body.channels).toEqual([
      expect.objectContaining({ code: 'ONLINE', kind: 'ONLINE', branchId: null, isActive: true }),
    ]);
    const list = await as(a, 'get', '/api/v1/locations');
    expect(list.body).toEqual({
      kinds: [
        { code: 'CITY', name: 'Ciudad' },
        { code: 'PORT', name: 'Puerto' },
        { code: 'LANDING', name: 'Embarcadero' },
        { code: 'TERMINAL', name: 'Terminal terrestre' },
      ],
      locations: [],
    });
  });

  it('ubicaciones: crear, validar, nombre único por empresa y editar', async () => {
    const created = await as(a, 'post', '/api/v1/locations', pucallpa);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ...pucallpa, archived: false, activeBranches: 0 });
    locationId = created.body.id;

    expect((await as(a, 'post', '/api/v1/locations', pucallpa)).status).toBe(409);
    for (const bad of [
      { ...pucallpa, name: 'Otra', ubigeo: '25010' },
      { ...pucallpa, name: 'Otra', lng: null },
      { ...pucallpa, name: 'Otra', kind: 'AIRPORT' },
      { ...pucallpa, name: 'Otra', lat: 120 },
      { ...pucallpa, name: 'Otra', extra: 1 },
    ]) {
      expect((await as(a, 'post', '/api/v1/locations', bad)).status).toBe(400);
    }
    // El mismo nombre en otra empresa no choca.
    expect((await as(b, 'post', '/api/v1/locations', pucallpa)).status).toBe(201);

    const edited = await as(a, 'put', `/api/v1/locations/${locationId}`, {
      ...pucallpa,
      kind: 'CITY',
      lat: null,
      lng: null,
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ kind: 'CITY', lat: null, lng: null });
  });

  it('sucursales: nacen con su mostrador; el código se normaliza y es único; solo en ubicaciones activas', async () => {
    const created = await as(a, 'post', '/api/v1/branches', branchInput(locationId));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: 'PCL-01', locationName: 'Pucallpa', archived: false });
    branchId = created.body.id;
    const channels = (await as(a, 'get', '/api/v1/sales-channels')).body.channels;
    expect(channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MOSTRADOR-PCL-01', kind: 'COUNTER', branchId, isActive: true }),
      ]),
    );

    expect((await as(a, 'post', '/api/v1/branches', branchInput(locationId))).status).toBe(409);
    expect(
      (await as(a, 'post', '/api/v1/branches', branchInput(locationId, { code: 'mal código' }))).status,
    ).toBe(400);
    expect(
      (await as(a, 'post', '/api/v1/branches', branchInput(locationId, { phones: ['abc'] }))).status,
    ).toBe(400);
    // El código no se edita: el PUT no lo admite.
    expect(
      (await as(a, 'put', `/api/v1/branches/${branchId}`, branchInput(locationId, { code: 'X' }))).status,
    ).toBe(400);
    const { code: _code, ...withoutCode } = branchInput(locationId, { name: 'Agencia Central' });
    const edited = await as(a, 'put', `/api/v1/branches/${branchId}`, withoutCode);
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ code: 'PCL-01', name: 'Agencia Central' });
  });

  it('archivar: la ubicación no se archiva con sucursales activas; el mostrador sigue a su sucursal', async () => {
    const blocked = await as(a, 'post', `/api/v1/locations/${locationId}/archive`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/una sucursal activa/);

    expect((await as(a, 'post', `/api/v1/branches/${branchId}/archive`)).body.archived).toBe(true);
    const counter = (await as(a, 'get', '/api/v1/sales-channels')).body.channels.find(
      (c: { kind: string }) => c.kind === 'COUNTER',
    );
    expect(counter.isActive).toBe(false);
    // No se reactiva el mostrador de una sucursal archivada.
    expect(
      (await as(a, 'put', `/api/v1/sales-channels/${counter.id}`, { name: 'Mostrador', isActive: true }))
        .status,
    ).toBe(409);

    const archived = await as(a, 'post', `/api/v1/locations/${locationId}/archive`);
    expect(archived.body).toMatchObject({ archived: true, activeBranches: 0 });
    // Ni sucursales nuevas ni restaurar una sucursal en una ubicación archivada.
    expect(
      (await as(a, 'post', '/api/v1/branches', branchInput(locationId, { code: 'PCL-02' }))).status,
    ).toBe(400);
    expect((await as(a, 'post', `/api/v1/branches/${branchId}/restore`)).status).toBe(400);

    expect((await as(a, 'post', `/api/v1/locations/${locationId}/restore`)).body.archived).toBe(false);
    expect((await as(a, 'post', `/api/v1/branches/${branchId}/restore`)).body.archived).toBe(false);
    const again = (await as(a, 'get', '/api/v1/sales-channels')).body.channels.find(
      (c: { id: string }) => c.id === counter.id,
    );
    expect(again.isActive).toBe(true);
    const renamed = await as(a, 'put', `/api/v1/sales-channels/${counter.id}`, {
      name: 'Ventanilla Malecón',
      isActive: false,
    });
    expect(renamed.body).toMatchObject({ name: 'Ventanilla Malecón', isActive: false, kind: 'COUNTER' });
  });

  it('aislamiento: otra empresa no ve ni usa lo de esta (404 o 400), ni por RLS ni por la API', async () => {
    const bLocations = (await as(b, 'get', '/api/v1/locations')).body.locations;
    expect(bLocations.map((l: { id: string }) => l.id)).not.toContain(locationId);
    expect((await as(b, 'get', '/api/v1/branches')).body.branches).toEqual([]);
    expect((await as(b, 'put', `/api/v1/locations/${locationId}`, pucallpa)).status).toBe(404);
    expect((await as(b, 'post', `/api/v1/branches/${branchId}/archive`)).status).toBe(404);
    // Una sucursal de B en la ubicación de A: la ubicación no existe para B.
    expect((await as(b, 'post', '/api/v1/branches', branchInput(locationId, { code: 'B-01' }))).status).toBe(
      400,
    );
    // Ids no válidos.
    expect((await as(a, 'put', '/api/v1/locations/no-es-un-id', pucallpa)).status).toBe(404);

    // RLS: sin contexto, 0 filas; con el de B, ninguna de A.
    const app_ = testPool('app', DB, 1);
    try {
      expect((await app_.query('SELECT count(*)::int AS n FROM branches')).rows[0].n).toBe(0);
      const c = await app_.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [b.id]);
        expect((await c.query('SELECT id FROM locations WHERE id = $1', [locationId])).rows).toEqual([]);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    } finally {
      await app_.end();
    }
  });

  it('reglas de la base: el código de la sucursal y la clase del canal no cambian; sin borrados', async () => {
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
    try {
      for (const sql of [
        `UPDATE branches SET code = 'OTRO' WHERE id = $1`,
        `UPDATE sales_channels SET kind = 'API' WHERE branch_id = $1`,
        `UPDATE sales_channels SET branch_id = NULL WHERE branch_id = $1`,
        `DELETE FROM branches WHERE id = $1`,
      ]) {
        await expect(inTenant(sql, [branchId])).rejects.toMatchObject({ code: '42501' });
      }
      await expect(inTenant(`DELETE FROM locations WHERE id = $1`, [locationId])).rejects.toMatchObject({
        code: '42501',
      });
      // CHECK: un segundo ONLINE choca con el código; un mostrador sin sucursal no existe.
      await expect(
        inTenant(
          `INSERT INTO sales_channels (id, tenant_id, code, name, kind) VALUES
                  (gen_random_uuid(), $1, 'ONLINE', 'Otro', 'ONLINE')`,
          [a.id],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        inTenant(
          `INSERT INTO sales_channels (id, tenant_id, code, name, kind) VALUES
                  (gen_random_uuid(), $1, 'CAJA', 'Caja', 'COUNTER')`,
          [a.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        inTenant(
          `INSERT INTO sales_channels (id, tenant_id, code, name, kind, branch_id) VALUES
                  (gen_random_uuid(), $1, 'MOSTRADOR-2', 'Otro', 'COUNTER', $2)`,
          [a.id, branchId],
        ),
      ).rejects.toMatchObject({ code: '23505' }); // un mostrador por sucursal
    } finally {
      c.release();
      await app_.end();
    }
  });

  it('ámbito de sucursal (F6-Q4): se asigna, se lista, sube la versión de permisos y solo admite activas', async () => {
    const members = (await as(a, 'get', '/api/v1/members')).body.members;
    const me = members[0];
    expect(me.branchIds).toEqual([]);
    // Una segunda persona (no se pueden cambiar los propios accesos en otros endpoints; aquí sí se permite).
    const userId = (
      await seed.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), 'cajera@ubic-a.pe', 'x', 'Cajera', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0]?.id as string;
    const membershipId = (
      await seed.query<{ id: string }>(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now()) RETURNING id`,
        [a.id, userId],
      )
    ).rows[0]?.id as string;
    const version = async () =>
      (
        await seed.query<{ v: number }>(
          'SELECT permissions_version AS v FROM tenant_memberships WHERE id = $1',
          [membershipId],
        )
      ).rows[0]?.v;
    const before = await version();

    const assigned = await as(a, 'put', `/api/v1/members/${membershipId}/branches`, {
      branchIds: [branchId],
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body).toEqual({ membershipId, branchIds: [branchId] });
    expect(await version()).toBe((before ?? 0) + 1);
    const listed = (await as(a, 'get', '/api/v1/members')).body.members.find(
      (m: { membershipId: string }) => m.membershipId === membershipId,
    );
    expect(listed.branchIds).toEqual([branchId]);

    // Otra empresa no la ve; una sucursal archivada o de otra empresa no se asigna.
    expect((await as(b, 'put', `/api/v1/members/${membershipId}/branches`, { branchIds: [] })).status).toBe(
      404,
    );
    const bLocation = (await as(b, 'get', '/api/v1/locations')).body.locations[0].id;
    const bBranch = (await as(b, 'post', '/api/v1/branches', branchInput(bLocation, { code: 'B-01' }))).body
      .id;
    expect(
      (await as(a, 'put', `/api/v1/members/${membershipId}/branches`, { branchIds: [bBranch] })).status,
    ).toBe(400);
    await as(a, 'post', `/api/v1/branches/${branchId}/archive`);
    expect(
      (await as(a, 'put', `/api/v1/members/${membershipId}/branches`, { branchIds: [branchId] })).status,
    ).toBe(400);
    await as(a, 'post', `/api/v1/branches/${branchId}/restore`);
    expect(
      (await as(a, 'put', `/api/v1/members/${membershipId}/branches`, { branchIds: [branchId, branchId] }))
        .status,
    ).toBe(400);
    const cleared = await as(a, 'put', `/api/v1/members/${membershipId}/branches`, { branchIds: [] });
    expect(cleared.body.branchIds).toEqual([]);

    // Sin locations.manage ni roles.assign (sin roles) → 403.
    expect((await as(a, 'get', '/api/v1/locations', undefined, userId)).status).toBe(403);
    expect((await as(a, 'post', '/api/v1/locations', pucallpa, userId)).status).toBe(403);
    expect(
      (await as(a, 'put', `/api/v1/members/${membershipId}/branches`, { branchIds: [] }, userId)).status,
    ).toBe(403);
    expect((await http().get('/api/v1/locations').set('Host', a.host)).status).toBe(401);
  });

  it('empresa suspendida: consulta, pero no configura (CONFIGURE)', async () => {
    const to = (status: string) =>
      asStaff('post', `/api/v1/platform/tenants/${a.id}/status`, { to: status, reason: 'Prueba 6.1' });
    expect((await to('PAST_DUE')).status).toBe(200);
    expect((await to('SUSPENDED')).status).toBe(200);
    try {
      expect((await as(a, 'get', '/api/v1/branches')).status).toBe(200);
      expect((await as(a, 'post', '/api/v1/locations', { ...pucallpa, name: 'Iquitos' })).status).toBe(403);
      expect((await as(a, 'post', `/api/v1/branches/${branchId}/archive`)).status).toBe(403);
    } finally {
      expect((await to('ACTIVE')).status).toBe(200);
    }
  });
});
