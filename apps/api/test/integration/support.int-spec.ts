/**
 * Fase 4.6 · Acceso de soporte del staff de YEBO a una empresa: sin acceso → 401; vencido, revocado, inactivo o con el
 * staff deshabilitado → 401; READ_ONLY no escribe; aprobación de la empresa; código de un solo uso; la empresa ve
 * quién accedió, cuándo y a qué; los cambios del staff quedan a su nombre. PostgreSQL y Redis reales.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { PERMISSION_CODES } from '../../src/modules/access/permission-catalog';
import { Clock } from '../../src/modules/identity/clock';
import { SessionService } from '../../src/modules/identity/session.service';
import { TenantResolverService } from '../../src/modules/tenancy/tenant-resolver.service';
import { testBypassPool, testPool } from '../support/db';
import { STAFF_CSRF, seedPlatformSession } from '../support/platform-session';

const DB = 'yebo_test';
const ADMIN = 'admin.yebo.pe';
const HOST_A = 'soporte-a.yebo.test';
const HOST_B = 'soporte-b.yebo.test';
const CSRF = 'csrf-de-prueba-0123456789abcdef';

class FakeClock extends Clock {
  current = new Date('2026-11-12T15:00:00Z');
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

let seq = 0;
const uuid = () => `0190f0a0-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

describe('Fase 4.6 · acceso de soporte', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  const clock = new FakeClock();
  const A = uuid();
  const B = uuid();
  let staff = { cookie: '', platformUserId: '' };
  let otherStaff = { cookie: '', platformUserId: '' };
  let viewer = '';
  let adminToken = '';
  let targetMembership = '';
  let adminUserId = '';
  /** Sesión nueva de la administradora con la hora actual del reloj (el access token dura 10 min). */
  const renewAdmin = async () => {
    const sessions = app.get(SessionService);
    const identity = (await sessions.createIdentitySession({ userId: adminUserId, authMethods: ['pwd'] })).id;
    adminToken = (await sessions.openTenantSession({ identitySessionId: identity, host: HOST_A }))
      .accessToken;
  };

  const http = () => request(app.getHttpServer());
  const asStaff = (method: 'get' | 'post', path: string, body?: object, cookie = staff.cookie) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', cookie);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  const renewStaff = async () => {
    staff = await seedPlatformSession(seed, {
      email: `soporte-${uuid()}@yebo.pe`,
      role: 'SUPPORT',
      now: clock.now(),
    });
    otherStaff = await seedPlatformSession(seed, {
      email: `otro-${uuid()}@yebo.pe`,
      role: 'SUPPORT',
      now: clock.now(),
    });
    viewer = (
      await seedPlatformSession(seed, { email: `ver-${uuid()}@yebo.pe`, role: 'VIEWER', now: clock.now() })
    ).cookie;
  };
  const grant = async (scope: 'FULL' | 'READ_ONLY', durationMinutes = 120) => {
    const res = await asStaff('post', `/api/v1/platform/tenants/${A}/support-grants`, {
      reason: 'Incidencia en el embarque',
      scope,
      durationMinutes,
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; status: string };
  };
  /** Abre la sesión de soporte en el host de la empresa con el enlace de un solo uso. */
  const open = async (grantId: string, host = HOST_A) => {
    const handoff = await asStaff('post', `/api/v1/platform/tenants/${A}/support-grants/${grantId}/handoff`);
    expect(handoff.status).toBe(200);
    const url = new URL(handoff.body.url);
    expect(url.host).toBe(HOST_A);
    const redeem = await http().get(`${url.pathname}${url.search}`).set('Host', host);
    return { redeem, code: url.searchParams.get('code') ?? '', cookie: supportCookie(redeem) };
  };
  const supportCookie = (res: request.Response) =>
    ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .find((c) => c.startsWith('__Host-yebo_support='))
      ?.split(';')[0] ?? '';
  const asSupport = (method: 'get' | 'post', path: string, cookie: string, body?: object, host = HOST_A) => {
    let req = http()[method](path).set('Host', host).set('Cookie', `${cookie}; __Host-yebo_csrf=${CSRF}`);
    if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
    return body ? req.send(body) : req;
  };
  const asAdmin = (method: 'get' | 'post' | 'put', path: string, body?: object) => {
    const agent = http();
    let req = agent[method](path)
      .set('Host', HOST_A)
      .set('Cookie', `__Host-yebo_at=${adminToken}; __Host-yebo_csrf=${CSRF}`);
    if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
    return body ? req.send(body) : req;
  };

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    seed = testBypassPool(DB, 2);
    await owner.query(
      `TRUNCATE support_access_logs, support_sessions, support_handoffs, support_access_grants, membership_status_history,
                membership_invitations, tenant_settings, platform_audit_logs, platform_setup_tokens, platform_sessions,
                platform_users, authorization_codes, refresh_tokens, tenant_sessions, identity_sessions,
                membership_roles, role_permissions, roles, tenant_memberships, users, tenant_domains, tenants CASCADE`,
    );
    await owner.query(
      `INSERT INTO permissions (id, code, module_code, description, is_sensitive, updated_at)
         SELECT gen_random_uuid(), c, 'ACCESS', c, false, now() FROM unnest($1::text[]) c
       ON CONFLICT (code) DO NOTHING`,
      [PERMISSION_CODES],
    );
    for (const [id, host] of [
      [A, HOST_A],
      [B, HOST_B],
    ] as const) {
      await owner.query(
        `INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id_type, tax_id, status, updated_at)
         VALUES ($1, $2, 'S', 'S', 'RUC', $3, 'ACTIVE', now())`,
        [id, host.split('.')[0], `20${String(++seq).padStart(9, '0')}`],
      );
      await owner.query(
        `INSERT INTO tenant_domains (id, tenant_id, host, kind, is_primary, verification_status, verified_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'SUBDOMAIN', true, 'VERIFIED', now(), now())`,
        [id, host],
      );
      await seed.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [id]);
    }
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    const nest = ref.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(nest, parseEnv(process.env), { swagger: false });
    await nest.init();
    app = nest;
    await app.get(TenantResolverService).invalidate(HOST_A);
    await app.get(TenantResolverService).invalidate(HOST_B);
    await renewStaff();

    // Administradora de la empresa A (todos los permisos) y otra persona a la que el soporte suspenderá.
    const roleId = uuid();
    await seed.query(
      `INSERT INTO roles (id, tenant_id, name, is_system, updated_at) VALUES ($1, $2, 'Admin', true, now())`,
      [roleId, A],
    );
    await seed.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE code = ANY($3)`,
      [A, roleId, PERMISSION_CODES],
    );
    const people: string[] = [];
    for (const name of ['jefa', 'operador']) {
      const userId = uuid();
      const membershipId = uuid();
      await seed.query(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at) VALUES ($1, $2, 'x', $3, 'ACTIVE', now())`,
        [userId, `${name}@soporte.pe`, name],
      );
      await seed.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at) VALUES ($1, $2, $3, 'ACTIVE', now())`,
        [membershipId, A, userId],
      );
      await seed.query(
        'INSERT INTO membership_roles (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)',
        [A, membershipId, roleId],
      );
      people.push(userId, membershipId);
    }
    targetMembership = people[3] ?? '';
    adminUserId = people[0] ?? '';
    const sessions = app.get(SessionService);
    const identity = (await sessions.createIdentitySession({ userId: people[0] ?? '', authMethods: ['pwd'] }))
      .id;
    adminToken = (await sessions.openTenantSession({ identitySessionId: identity, host: HOST_A }))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  it('sin acceso no hay sesión: cookie inventada → 401; VIEWER no crea accesos; otro miembro del staff no usa el ajeno', async () => {
    expect((await asSupport('get', '/api/v1/members', '__Host-yebo_support=' + 'x'.repeat(43))).status).toBe(
      401,
    );
    expect(
      (
        await asStaff(
          'post',
          `/api/v1/platform/tenants/${A}/support-grants`,
          { reason: 'Mirar', scope: 'FULL' },
          viewer,
        )
      ).status,
    ).toBe(403);
    const g = await grant('FULL');
    expect(
      (
        await asStaff(
          'post',
          `/api/v1/platform/tenants/${A}/support-grants/${g.id}/handoff`,
          undefined,
          otherStaff.cookie,
        )
      ).status,
    ).toBe(404);
  });

  it('FULL: entra, lee y escribe; los cambios quedan a nombre del staff; no gestiona su propio acceso ni la sesión de persona', async () => {
    const g = await grant('FULL');
    expect(g.status).toBe('ACTIVE');
    const { redeem, cookie } = await open(g.id);
    expect(redeem.status).toBe(302);
    expect(redeem.headers.location).toBe('/panel');
    expect(cookie).toMatch(/^__Host-yebo_support=/);
    expect((await asSupport('get', '/api/v1/members', cookie)).status).toBe(200);
    expect((await asSupport('post', `/api/v1/members/${targetMembership}/suspend`, cookie)).status).toBe(200);
    expect(
      await seed
        .query(
          `SELECT changed_by_kind::text AS kind, changed_by_id AS id FROM membership_status_history
          WHERE membership_id = $1 AND valid_to IS NULL`,
          [targetMembership],
        )
        .then((r) => r.rows),
    ).toEqual([{ kind: 'PLATFORM_USER', id: staff.platformUserId }]);
    const roleId = (await seed.query<{ id: string }>('SELECT id FROM roles WHERE tenant_id = $1', [A]))
      .rows[0]?.id;
    const invite = await asSupport('post', '/api/v1/invitations', cookie, {
      email: 'nuevo@soporte.pe',
      roleIds: [roleId],
    });
    expect(invite.status).toBe(201);
    expect(
      (
        await seed.query(
          'SELECT invited_by_platform_user_id AS p FROM membership_invitations WHERE id = $1',
          [invite.body.id],
        )
      ).rows,
    ).toEqual([{ p: staff.platformUserId }]);
    expect((await asSupport('get', '/api/v1/auth/session', cookie)).status).toBe(403);
    expect((await asSupport('post', `/api/v1/support-access/${g.id}/revoke`, cookie)).status).toBe(403);
    // Sin CSRF, una mutación se rechaza también para el soporte.
    const noCsrf = await http()
      .post(`/api/v1/members/${targetMembership}/reactivate`)
      .set('Host', HOST_A)
      .set('Cookie', cookie);
    expect(noCsrf.status).toBe(403);
  });

  it('el código es de un solo uso, caduca a los 60 s y no sirve en otra empresa; la sesión no sirve en otro host', async () => {
    const g = await grant('FULL');
    const first = await open(g.id);
    expect(first.redeem.status).toBe(302);
    expect((await http().get(`/api/v1/support/session?code=${first.code}`).set('Host', HOST_A)).status).toBe(
      401,
    );
    // Un código de A canjeado en B no existe allí (RLS).
    const crossed = await open(g.id, HOST_B);
    expect(crossed.redeem.status).toBe(401);
    // Caducado.
    const handoff = await asStaff('post', `/api/v1/platform/tenants/${A}/support-grants/${g.id}/handoff`);
    clock.advance(61_000);
    const late = new URL(handoff.body.url);
    expect((await http().get(`${late.pathname}${late.search}`).set('Host', HOST_A)).status).toBe(401);
    // La cookie de A en el host de B → 401.
    expect((await asSupport('get', '/api/v1/members', first.cookie, undefined, HOST_B)).status).toBe(401);
    await renewStaff();
  });

  it('READ_ONLY: consulta sí, escribe no', async () => {
    const g = await grant('READ_ONLY');
    const { cookie } = await open(g.id);
    expect((await asSupport('get', '/api/v1/members', cookie)).status).toBe(200);
    const write = await asSupport('post', `/api/v1/members/${targetMembership}/reactivate`, cookie);
    expect(write.status).toBe(403);
    expect(write.body.error.message).toMatch(/solo lectura/);
  });

  it('revocado por la empresa o por el staff, vencido, inactivo o con el staff deshabilitado → 401', async () => {
    await renewAdmin();
    const byTenant = await grant('FULL');
    const s1 = await open(byTenant.id);
    expect((await asAdmin('post', `/api/v1/support-access/${byTenant.id}/revoke`)).status).toBe(204);
    expect((await asSupport('get', '/api/v1/members', s1.cookie)).status).toBe(401);

    const byStaff = await grant('FULL');
    const s2 = await open(byStaff.id);
    expect(
      (await asStaff('post', `/api/v1/platform/tenants/${A}/support-grants/${byStaff.id}/revoke`)).status,
    ).toBe(204);
    expect((await asSupport('get', '/api/v1/members', s2.cookie)).status).toBe(401);

    const short = await grant('FULL', 15);
    const s3 = await open(short.id);
    expect((await asSupport('get', '/api/v1/members', s3.cookie)).status).toBe(200);
    clock.advance(15 * 60_000);
    expect((await asSupport('get', '/api/v1/members', s3.cookie)).status).toBe(401);
    // Vencido, tampoco emite enlaces nuevos (la sesión de staff sigue viva: se renueva sin cambiar de persona).
    await seed.query(
      `UPDATE platform_sessions SET last_seen_at = $2, idle_expires_at = $2::timestamptz + interval '30 minutes'
        WHERE platform_user_id = $1`,
      [staff.platformUserId, clock.now()],
    );
    expect(
      (await asStaff('post', `/api/v1/platform/tenants/${A}/support-grants/${short.id}/handoff`)).status,
    ).toBe(409);
    await renewStaff();

    const idle = await grant('FULL', 240);
    const s4 = await open(idle.id);
    clock.advance(31 * 60_000);
    expect((await asSupport('get', '/api/v1/members', s4.cookie)).status).toBe(401);
    await renewStaff();

    const g5 = await grant('FULL');
    const s5 = await open(g5.id);
    await seed.query("UPDATE platform_users SET status = 'DISABLED' WHERE id = $1", [staff.platformUserId]);
    expect((await asSupport('get', '/api/v1/members', s5.cookie)).status).toBe(401);
    await renewStaff();
  });

  it('aprobación de la empresa: pendiente hasta aprobar; la empresa ve quién accedió, cuándo y a qué', async () => {
    await renewAdmin();
    expect((await asAdmin('put', '/api/v1/support-access/settings', { requiresApproval: true })).status).toBe(
      200,
    );
    const g = await grant('FULL');
    expect(g.status).toBe('PENDING_APPROVAL');
    expect(
      (await asStaff('post', `/api/v1/platform/tenants/${A}/support-grants/${g.id}/handoff`)).status,
    ).toBe(409);
    expect((await asAdmin('post', `/api/v1/support-access/${g.id}/approve`)).status).toBe(204);
    const { cookie } = await open(g.id);
    expect((await asSupport('get', '/api/v1/roles', cookie)).status).toBe(200);
    await asAdmin('put', '/api/v1/support-access/settings', { requiresApproval: false });

    const seen = await asAdmin('get', '/api/v1/support-access');
    expect(seen.status).toBe(200);
    const mine = seen.body.grants.find((x: { id: string }) => x.id === g.id);
    expect(mine).toMatchObject({
      status: 'ACTIVE',
      requiresApproval: true,
      scope: 'FULL',
      reason: 'Incidencia en el embarque',
    });
    expect(mine.staffEmail).toMatch(/@yebo\.pe$/);
    expect(mine.accesses).toEqual([expect.objectContaining({ method: 'GET', route: '/api/v1/roles' })]);
    // Otra empresa no ve los accesos de A.
    const appPool = testPool('app', DB, 1);
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [B]);
      expect((await c.query('SELECT 1 FROM support_access_grants')).rowCount).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
      await appPool.end();
    }
  });

  it('el registro de accesos es append-only y todo queda en la auditoría del staff', async () => {
    await expect(seed.query("UPDATE support_access_logs SET route = '/otra'")).rejects.toMatchObject({
      code: 'P0001',
    });
    await expect(seed.query('DELETE FROM support_access_logs')).rejects.toMatchObject({ code: 'P0001' });
    const actions = (
      await seed.query<{ action: string }>(
        "SELECT DISTINCT action FROM platform_audit_logs WHERE action LIKE 'support.%' ORDER BY 1",
      )
    ).rows.map((r) => r.action);
    expect(actions).toEqual([
      'support.grant_created',
      'support.grant_revoked',
      'support.handoff_issued',
      'support.session_started',
    ]);
  });
});
