/**
 * Fase 6.5 · Agencias externas (data-dictionary §3; F6-Q2). PostgreSQL y Redis reales: el módulo AGENCIES apagado
 * responde 403 y, encendido por YEBO, deja registrar agencias; cada agencia nace con su canal EXTERNAL_AGENCY, que
 * sigue a su agencia al archivarla; RUC válido, único por empresa e inmutable; aislamiento entre empresas (RLS),
 * reglas de la base, permisos y estados del tenant.
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

/** RUC reales de prueba con su dígito verificador (BCP y SUNAT). */
const RUC = '20100047218';
const OTHER_RUC = '20131312955';
const agencyInput = (over: object = {}) => ({
  taxId: RUC,
  name: 'Viajes Amazonía',
  contactName: 'Rosa Pérez',
  contactPhone: '+51 61 575757',
  contactEmail: 'Ventas@ViajesAmazonia.pe',
  ...over,
});

describe('Fase 6.5 · agencias externas', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let staff = '';
  let a: Company;
  let b: Company;
  let grantId = '';

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
  const grant = (c: Company) =>
    asStaff('post', `/api/v1/platform/tenants/${c.id}/module-overrides`, {
      moduleCode: 'AGENCIES',
      effect: 'GRANT',
      reason: 'Piloto de agencias externas',
    });
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
    staff = (await seedPlatformSession(seed, { email: 'agen@yebo.pe', role: 'SUPERADMIN', now: new Date() }))
      .cookie;
    // El plan no incluye AGENCIES: el módulo está apagado por defecto (ADR-020, F6-Q2).
    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'agen', name: 'Agencias' });
    const v = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
      basePrice: '99.00',
      billingInterval: 'MONTHLY',
      includedUsers: 5,
      extraUserPrice: '15.00',
      trialDays: 0,
      modules: ['PASSENGERS'],
    });
    await asStaff('post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
    a = await company('agen-a', v.body.id);
    b = await company('agen-b', v.body.id);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  let agencyId = '';
  let channelId = '';

  it('módulo AGENCIES apagado: 403 MODULE_NOT_ENABLED en todas las rutas, aun con el permiso', async () => {
    for (const [method, path, body] of [
      ['get', '/api/v1/agencies', undefined],
      ['post', '/api/v1/agencies', agencyInput()],
      ['put', '/api/v1/agencies/0190f0a0-0000-7000-8000-000000000001', agencyInput()],
      ['post', '/api/v1/agencies/0190f0a0-0000-7000-8000-000000000001/archive', undefined],
    ] as const) {
      const res = await as(a, method, path, body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MODULE_NOT_ENABLED');
    }
  });

  it('con el módulo encendido por YEBO: alta con su canal EXTERNAL_AGENCY, datos normalizados', async () => {
    const granted = await grant(a);
    expect(granted.status).toBe(201);
    grantId = granted.body.id;

    expect((await as(a, 'get', '/api/v1/agencies')).body).toEqual({ agencies: [] });
    const created = await as(a, 'post', '/api/v1/agencies', agencyInput());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      taxId: RUC,
      name: 'Viajes Amazonía',
      contactEmail: 'ventas@viajesamazonia.pe',
      archived: false,
      channel: { code: `AGENCIA-${RUC}`, isActive: true },
    });
    agencyId = created.body.id;
    channelId = created.body.channel.id;

    const channel = (await as(a, 'get', '/api/v1/sales-channels')).body.channels.find(
      (c: { id: string }) => c.id === channelId,
    );
    expect(channel).toEqual({
      id: channelId,
      code: `AGENCIA-${RUC}`,
      name: 'Agencia Viajes Amazonía',
      kind: 'EXTERNAL_AGENCY',
      branchId: null,
      agencyId,
      isActive: true,
    });

    // Sin datos de contacto: vacío = null. Un nombre largo no rompe el nombre del canal (80 caracteres).
    const minimal = await as(a, 'post', '/api/v1/agencies', {
      taxId: OTHER_RUC,
      name: 'N'.repeat(80),
      contactName: '',
      contactPhone: null,
      contactEmail: '',
    });
    expect(minimal.status).toBe(201);
    expect(minimal.body).toMatchObject({ contactName: null, contactPhone: null, contactEmail: null });
    const list = (await as(a, 'get', '/api/v1/agencies')).body.agencies;
    expect(list.map((x: { taxId: string }) => x.taxId)).toEqual([OTHER_RUC, RUC]); // por nombre
  });

  it('validación: RUC con su dígito verificador, único por empresa e inmutable; campos de más → 400', async () => {
    for (const bad of [
      agencyInput({ taxId: '20100047219' }),
      agencyInput({ taxId: '30100047218' }),
      agencyInput({ taxId: OTHER_RUC, contactEmail: 'no-es-correo' }),
      agencyInput({ taxId: OTHER_RUC, contactPhone: 'llamar' }),
      agencyInput({ taxId: OTHER_RUC, commission: 10 }),
    ]) {
      expect((await as(a, 'post', '/api/v1/agencies', bad)).status).toBe(400);
    }
    const dup = await as(a, 'post', '/api/v1/agencies', agencyInput({ name: 'Otra' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toMatch(/Ya existe una agencia con el RUC 20100047218/);

    // Editar: nombre y contacto sí; el RUC no se acepta.
    const { taxId: _ignored, ...editable } = agencyInput();
    const edited = await as(a, 'put', `/api/v1/agencies/${agencyId}`, {
      ...editable,
      name: 'Viajes Amazonía SAC',
      contactPhone: '',
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ name: 'Viajes Amazonía SAC', contactPhone: null, taxId: RUC });
    expect((await as(a, 'put', `/api/v1/agencies/${agencyId}`, agencyInput())).status).toBe(400);
    expect((await as(a, 'put', '/api/v1/agencies/no-es-un-id', editable)).status).toBe(404);
  });

  it('archivar: el canal sigue a su agencia y no se reactiva mientras esté archivada', async () => {
    const archived = await as(a, 'post', `/api/v1/agencies/${agencyId}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ archived: true, channel: { id: channelId, isActive: false } });
    const reactivate = await as(a, 'put', `/api/v1/sales-channels/${channelId}`, {
      name: 'Agencia',
      isActive: true,
    });
    expect(reactivate.status).toBe(409);
    expect(reactivate.body.error.message).toMatch(/agencia archivada/);
    // Archivada sigue ocupando su RUC: se restaura en vez de repetirla.
    expect((await as(a, 'post', '/api/v1/agencies', agencyInput())).status).toBe(409);

    const restored = await as(a, 'post', `/api/v1/agencies/${agencyId}/restore`);
    expect(restored.body).toMatchObject({ archived: false, channel: { isActive: true } });
    // Activa, su canal se puede pausar y renombrar como cualquier otro.
    const paused = await as(a, 'put', `/api/v1/sales-channels/${channelId}`, {
      name: 'Agencia Amazonía',
      isActive: false,
    });
    expect(paused.body).toMatchObject({ name: 'Agencia Amazonía', isActive: false, kind: 'EXTERNAL_AGENCY' });
  });

  it('aislamiento: otra empresa no ve ni toca las agencias de esta, ni por la API ni por RLS', async () => {
    expect((await grant(b)).status).toBe(201);
    expect((await as(b, 'get', '/api/v1/agencies')).body.agencies).toEqual([]);
    const { taxId: _ignored, ...editable } = agencyInput();
    expect((await as(b, 'put', `/api/v1/agencies/${agencyId}`, editable)).status).toBe(404);
    expect((await as(b, 'post', `/api/v1/agencies/${agencyId}/archive`)).status).toBe(404);
    // El mismo RUC en otra empresa no choca.
    expect((await as(b, 'post', '/api/v1/agencies', agencyInput())).status).toBe(201);

    const app_ = testPool('app', DB, 1);
    try {
      expect((await app_.query('SELECT count(*)::int AS n FROM agencies')).rows[0].n).toBe(0);
      const c = await app_.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [b.id]);
        expect((await c.query('SELECT id FROM agencies WHERE id = $1', [agencyId])).rows).toEqual([]);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    } finally {
      await app_.end();
    }
  });

  it('reglas de la base: el RUC y la agencia del canal no cambian; sin borrados; canal de agencia ⇔ agencia', async () => {
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
        `UPDATE agencies SET tax_id = '20131312955' WHERE id = $1`,
        `UPDATE sales_channels SET agency_id = NULL WHERE agency_id = $1`,
        `DELETE FROM agencies WHERE id = $1`,
      ]) {
        await expect(inTenant(sql, [agencyId])).rejects.toMatchObject({ code: '42501' });
      }
      // Canal de agencia sin agencia, u otra clase con agencia → 23514; dos canales para una agencia → 23505.
      await expect(
        inTenant(
          `INSERT INTO sales_channels (id, tenant_id, code, name, kind) VALUES
                  (gen_random_uuid(), $1, 'AGENCIA-X', 'Sin agencia', 'EXTERNAL_AGENCY')`,
          [a.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        inTenant(
          `INSERT INTO sales_channels (id, tenant_id, code, name, kind, agency_id) VALUES
                  (gen_random_uuid(), $1, 'CENTRAL', 'Central', 'CALL_CENTER', $2)`,
          [a.id, agencyId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        inTenant(
          `INSERT INTO sales_channels (id, tenant_id, code, name, kind, agency_id) VALUES
                  (gen_random_uuid(), $1, 'AGENCIA-2', 'Otro', 'EXTERNAL_AGENCY', $2)`,
          [a.id, agencyId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      // RUC mal formado → 23514 (el dígito verificador lo comprueba la API).
      await expect(
        inTenant(
          `INSERT INTO agencies (id, tenant_id, name, tax_id) VALUES (gen_random_uuid(), $1, 'Mala', '123')`,
          [a.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      c.release();
      await app_.end();
    }
  });

  it('permisos: sin agencies.manage → 403; sin sesión → 401', async () => {
    const userId = (
      await seed.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), 'cajera@agen-a.pe', 'x', 'Cajera', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0]?.id as string;
    await seed.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [a.id, userId],
    );
    expect((await as(a, 'get', '/api/v1/agencies', undefined, userId)).status).toBe(403);
    expect((await as(a, 'post', '/api/v1/agencies', agencyInput({ taxId: OTHER_RUC }), userId)).status).toBe(
      403,
    );
    expect((await http().get('/api/v1/agencies').set('Host', a.host)).status).toBe(401);
  });

  it('empresa suspendida: consulta, pero no configura (CONFIGURE)', async () => {
    const to = (status: string) =>
      asStaff('post', `/api/v1/platform/tenants/${a.id}/status`, { to: status, reason: 'Prueba 6.5' });
    expect((await to('PAST_DUE')).status).toBe(200);
    expect((await to('SUSPENDED')).status).toBe(200);
    try {
      expect((await as(a, 'get', '/api/v1/agencies')).status).toBe(200);
      const { taxId: _ignored, ...editable } = agencyInput();
      expect((await as(a, 'put', `/api/v1/agencies/${agencyId}`, editable)).status).toBe(403);
      expect((await as(a, 'post', `/api/v1/agencies/${agencyId}/archive`)).status).toBe(403);
    } finally {
      expect((await to('ACTIVE')).status).toBe(200);
    }
  });

  it('al terminar la excepción de YEBO, el módulo se apaga de nuevo: 403, y los datos se conservan', async () => {
    const ended = await asStaff('post', `/api/v1/platform/tenants/${a.id}/module-overrides/${grantId}/end`);
    expect(ended.status).toBe(204);
    expect((await as(a, 'get', '/api/v1/agencies')).status).toBe(403);
    // El canal de la agencia sigue en la lista de canales (locations.manage no depende del módulo).
    const channels = (await as(a, 'get', '/api/v1/sales-channels')).body.channels;
    expect(channels.some((c: { id: string }) => c.id === channelId)).toBe(true);
    expect(
      (await seed.query('SELECT count(*)::int AS n FROM agencies WHERE tenant_id = $1', [a.id])).rows[0].n,
    ).toBe(2);
  });
});
