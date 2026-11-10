/**
 * Fase 4.3b · Invitaciones: primer administrador invitado en el alta, invitaciones de la empresa (USERS_ADD) y
 * aceptación en el hub (con cuenta o creándola), un solo uso, caducidad, revocación, estado del tenant y aislamiento.
 * PostgreSQL y Redis reales; reloj controlado.
 */
import { createHash } from 'node:crypto';
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
import { Clock } from '../../src/modules/identity/clock';
import { CookieSigner } from '../../src/modules/identity/http/cookie-signer';
import { PasswordHasher } from '../../src/modules/identity/password-hasher';
import { SessionService } from '../../src/modules/identity/session.service';
import { testBypassPool, testPool } from '../support/db';
import { STAFF_CSRF, seedPlatformSession } from '../support/platform-session';

const DB = 'yebo_test';
const ADMIN = 'admin.yebo.pe';
const HUB = 'cuentas.yebo.pe';
const CSRF = 'csrf-de-prueba-0123456789abcdef';
const PASSWORD = 'ríos-claros-del-ucayali';

class FakeClock extends Clock {
  current = new Date('2026-11-10T15:00:00Z');
  now(): Date {
    return this.current;
  }
}

describe('Fase 4.3b · invitaciones de membresía', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  const clock = new FakeClock();
  let staff = '';
  let viewer = '';
  let version = '';
  let renewals = 0;

  const http = () => request(app.getHttpServer());
  const admin = (method: 'get' | 'post', path: string, body?: object, cookie = staff) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', cookie);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  const renewStaff = async () => {
    const n = (renewals += 1);
    staff = (
      await seedPlatformSession(seed, { email: `super-${n}@yebo.pe`, role: 'SUPERADMIN', now: clock.now() })
    ).cookie;
    viewer = (
      await seedPlatformSession(seed, { email: `viewer-${n}@yebo.pe`, role: 'VIEWER', now: clock.now() })
    ).cookie;
  };
  /** Petición al hub con CSRF y, si se da, la sesión de identidad firmada. */
  const hub = (path: string, body: object, identitySessionId?: string) => {
    const cookies = [`__Host-yebo_csrf=${CSRF}`];
    if (identitySessionId) {
      cookies.push(`__Host-yebo_hub=${app.get(CookieSigner).sign('hub-session', identitySessionId)}`);
    }
    return http()
      .post(`/api/v1/hub/invitations/${path}`)
      .set('Host', HUB)
      .set('Cookie', cookies.join('; '))
      .set('X-CSRF-Token', CSRF)
      .send(body);
  };
  const tokenOf = (link: string) => link.split('#')[1] ?? '';
  /** Empresa nueva con el primer administrador invitado. */
  const createTenant = async (slug: string, firstAdminEmail?: string) => {
    const res = await admin('post', '/api/v1/platform/tenants', {
      slug,
      legalName: `${slug} SAC`,
      tradeName: `Empresa ${slug}`,
      taxId: `20${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      planVersionId: version,
      services: [{ modality: 'LAND', service: 'PASSENGER' }],
      ...(firstAdminEmail && { firstAdminEmail }),
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; primaryHost: string; firstAdminInvitation: { link: string } | null };
  };
  /** Persona con cuenta (contraseña real) y sesión de identidad abierta. */
  const person = async (email: string): Promise<{ userId: string; identity: string }> => {
    const hash = await app.get(PasswordHasher).hash(PASSWORD);
    const userId = (
      await owner.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'Persona', 'ACTIVE', now()) RETURNING id`,
        [email, hash],
      )
    ).rows[0]?.id as string;
    const identity = (await app.get(SessionService).createIdentitySession({ userId, authMethods: ['pwd'] }))
      .id;
    return { userId, identity };
  };
  /** Sesión de empresa de un usuario ya miembro. */
  const tenantToken = async (identity: string, host: string) =>
    (await app.get(SessionService).openTenantSession({ identitySessionId: identity, host })).accessToken;
  const asTenant = (method: 'get' | 'post', path: string, host: string, token: string, body?: object) => {
    const agent = http();
    let req = agent[method](path)
      .set('Host', host)
      .set('Cookie', `__Host-yebo_at=${token}; __Host-yebo_csrf=${CSRF}`);
    if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
    return body ? req.send(body) : req;
  };
  const adminRoleOf = async (tenantId: string) =>
    (
      await seed.query<{ id: string }>(
        "SELECT id FROM roles WHERE tenant_id = $1 AND name = 'Administrador'",
        [tenantId],
      )
    ).rows[0]?.id as string;

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    seed = testBypassPool(DB, 2);
    await owner.query(
      `TRUNCATE membership_invitations, plan_version_modules, subscriptions, tenant_module_overrides, plan_versions,
                plans, tenant_settings, tenant_services, tenant_status_history, tenant_operation_overrides,
                platform_audit_logs, platform_setup_tokens, platform_sessions, platform_users,
                authorization_codes, refresh_tokens, tenant_sessions, identity_sessions, membership_roles,
                role_permissions, roles, tenant_memberships, users, tenant_domains, tenants CASCADE`,
    );
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(nest, parseEnv(process.env), { swagger: false });
    await nest.init();
    await nest.listen(0, '127.0.0.1');
    app = nest;
    // Límites de intentos de ejecuciones anteriores (Redis persiste entre ejecuciones).
    const redis = app.get(RedisService);
    const keys = await redis.client.keys('rl:*');
    if (keys.length > 0) await redis.client.del(...keys);
    await renewStaff();
    const plan = await admin('post', '/api/v1/platform/plans', { code: 'base', name: 'Base' });
    version = (
      await admin('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
        basePrice: '99.00',
        billingInterval: 'MONTHLY',
        includedUsers: 5,
        extraUserPrice: '15.00',
        trialDays: 0,
        modules: ['PASSENGERS'],
      })
    ).body.id;
    await admin('post', `/api/v1/platform/plan-versions/${version}/publish`);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  describe('primer administrador (alta de la empresa)', () => {
    let tenant: Awaited<ReturnType<typeof createTenant>>;

    beforeAll(async () => {
      tenant = await createTenant('primera', 'Gerencia@Primera.PE');
    });

    it('el alta devuelve el enlace una vez; la base guarda solo el hash del secreto', async () => {
      const link = tenant.firstAdminInvitation?.link ?? '';
      expect(link).toMatch(new RegExp(`^https://${HUB}/invitacion#${tenant.id}\\.[A-Za-z0-9_-]{43}$`));
      const secret = tokenOf(link).split('.')[1] ?? '';
      const { rows } = await seed.query<{
        email: string;
        token_hash: Buffer;
        invited_by_platform_user_id: string;
      }>(
        'SELECT email::text, token_hash, invited_by_platform_user_id FROM membership_invitations WHERE tenant_id = $1',
        [tenant.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.email).toBe('gerencia@primera.pe');
      expect(rows[0]?.token_hash.equals(createHash('sha256').update(secret).digest())).toBe(true);
      expect(rows[0]?.invited_by_platform_user_id).toBeTruthy();
      const audit = await seed.query<{ detail: object }>(
        "SELECT detail FROM platform_audit_logs WHERE action = 'invitation.created' AND tenant_id = $1",
        [tenant.id],
      );
      expect(JSON.stringify(audit.rows)).not.toContain('gerencia@'); // sin datos personales en la auditoría
    });

    it('vista previa: empresa, correo y caducidad; token inválido → 404 con el mismo mensaje', async () => {
      const token = tokenOf(tenant.firstAdminInvitation?.link ?? '');
      const preview = await hub('preview', { token });
      expect(preview.status).toBe(200);
      expect(preview.body).toEqual({
        tradeName: 'Empresa primera',
        email: 'gerencia@primera.pe',
        expiresAt: new Date(clock.now().getTime() + 72 * 3_600_000).toISOString(),
      });
      const [tenantId, secret] = token.split('.');
      const bad = [
        'basura',
        `${tenantId}.${'A'.repeat(43)}`, // tenant real, secreto falso
        `0190f0a0-0000-7000-8000-0000000000ee.${secret}`, // secreto real, otro tenant: RLS no lo encuentra
      ];
      const messages = new Set<string>();
      for (const t of bad) {
        const res = await hub('preview', { token: t });
        expect(res.status).toBe(404);
        messages.add(res.body.error.message);
      }
      expect(messages.size).toBe(1);
    });

    it('crear la cuenta: política de contraseñas; después, cuenta sin verificar, membresía ACTIVE con Administrador y sesión del hub', async () => {
      const token = tokenOf(tenant.firstAdminInvitation?.link ?? '');
      for (const password of ['corta', '1234567890', 'gerencia-de-la-empresa', 'clave-de-yebo-segura']) {
        const res = await hub('register', { token, fullName: 'Rosa Gerencia', password });
        expect({ password, status: res.status }).toEqual({ password, status: 400 });
      }
      const res = await hub('register', { token, fullName: 'Rosa Gerencia', password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tradeName: 'Empresa primera', tenantHost: 'primera.yebo.pe' });
      expect(String(res.headers['set-cookie'])).toMatch(/__Host-yebo_hub=/);

      const user = await owner.query<{ id: string; email_verified_at: Date | null; full_name: string }>(
        "SELECT id, email_verified_at, full_name FROM users WHERE email = 'gerencia@primera.pe'",
      );
      expect(user.rows[0]).toMatchObject({ email_verified_at: null, full_name: 'Rosa Gerencia' });
      const membership = await seed.query(
        `SELECT m.status::text, r.name FROM tenant_memberships m
           JOIN membership_roles mr ON mr.membership_id = m.id JOIN roles r ON r.id = mr.role_id
          WHERE m.tenant_id = $1 AND m.user_id = $2`,
        [tenant.id, user.rows[0]?.id],
      );
      expect(membership.rows).toEqual([{ status: 'ACTIVE', name: 'Administrador' }]);
      // Historial de medición (Fase 4.4): el alta tiene como autora a la persona que aceptó.
      const history = await seed.query(
        `SELECT changed_by_kind::text AS kind, changed_by_id AS id, reason FROM membership_status_history
          WHERE tenant_id = $1 AND user_id = $2`,
        [tenant.id, user.rows[0]?.id],
      );
      expect(history.rows).toEqual([{ kind: 'USER', id: user.rows[0]?.id, reason: 'invitation.accepted' }]);

      // La sesión del hub que abre el registro ya ve la empresa.
      const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('__Host-yebo_hub='),
      );
      const companies = await http()
        .get('/api/v1/hub/me/memberships')
        .set('Host', HUB)
        .set('Cookie', cookie?.split(';')[0] ?? '');
      expect(companies.body.memberships).toEqual([
        { tenantId: tenant.id, tradeName: 'Empresa primera', host: 'primera.yebo.pe' },
      ]);
    });

    it('un solo uso: reutilizar el enlace → 404 en la vista previa, al aceptar y al registrarse', async () => {
      const token = tokenOf(tenant.firstAdminInvitation?.link ?? '');
      expect((await hub('preview', { token })).status).toBe(404);
      expect((await hub('register', { token, fullName: 'Otra', password: PASSWORD })).status).toBe(404);
    });

    it('panel: «Invitar usuario» a una empresa con roles elegidos de esa empresa', async () => {
      const roles = await admin('get', `/api/v1/platform/tenants/${tenant.id}/roles`, undefined, viewer);
      expect(roles.body.roles).toEqual([{ id: expect.any(String), name: 'Administrador', isSystem: true }]);
      const res = await admin('post', '/api/v1/platform/invitations', {
        target: 'TENANT',
        tenantId: tenant.id,
        email: 'Otro@Primera.pe',
        roleIds: [roles.body.roles[0].id],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ target: 'TENANT', email: 'otro@primera.pe' });
      expect(res.body.link).toContain(`/invitacion#${tenant.id}.`);
      expect(res.headers['cache-control']).toBe('no-store');
      // La invitación del panel se acepta en el hub como cualquier otra.
      expect((await hub('preview', { token: tokenOf(res.body.link) })).body.email).toBe('otro@primera.pe');
      const other = await createTenant('vecina');
      const foreign = await admin('post', '/api/v1/platform/invitations', {
        target: 'TENANT',
        tenantId: tenant.id,
        email: 'x@primera.pe',
        roleIds: [await adminRoleOf(other.id)],
      });
      expect(foreign.status).toBe(400); // rol de otra empresa
      const missing = await admin('post', '/api/v1/platform/invitations', {
        target: 'TENANT',
        tenantId: '0190f0a0-0000-7000-8000-0000000000ee',
        email: 'x@primera.pe',
        roleIds: [roles.body.roles[0].id],
      });
      expect(missing.status).toBe(404);
    });

    it('panel: «Invitar usuario» al staff de YEBO con su rol de plataforma y enlace de configuración', async () => {
      const res = await admin('post', '/api/v1/platform/invitations', {
        target: 'STAFF',
        email: 'Nuevo.Staff@yebo.pe',
        fullName: 'Nuevo Staff',
        role: 'SUPPORT',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ target: 'STAFF', email: 'nuevo.staff@yebo.pe' });
      expect(res.body.link).toContain(ADMIN);
      const row = await seed.query<{ role: string; status: string }>(
        "SELECT role::text, status::text FROM platform_users WHERE email = 'nuevo.staff@yebo.pe'",
      );
      expect(row.rows).toEqual([{ role: 'SUPPORT', status: 'ACTIVE' }]);
      expect(res.body.id).toBe(
        (
          await seed.query<{ id: string }>(
            "SELECT id FROM platform_users WHERE email = 'nuevo.staff@yebo.pe'",
          )
        ).rows[0]?.id,
      );
      // Solo correos del dominio del staff (PLATFORM_STAFF_EMAIL_DOMAIN): ni otros dominios ni imitaciones.
      for (const email of ['alguien@gmail.com', 'x@yebo.pe.evil.com', 'x@sub.yebo.pe', 'x@notyebo.pe']) {
        const bad = await admin('post', '/api/v1/platform/invitations', {
          target: 'STAFF',
          email,
          fullName: 'Fuera',
          role: 'VIEWER',
        });
        expect(bad.status).toBe(400);
        expect(bad.body.error.message).toBe('El staff solo admite correos @yebo.pe');
      }
      expect((await seed.query("SELECT 1 FROM platform_users WHERE full_name = 'Fuera'")).rowCount).toBe(0);
      // La entrada de la 4.1 se retiró: «Invitar usuario» es la única forma de dar de alta al staff.
      expect(
        (await admin('post', '/api/v1/platform/staff', { email: 'z@yebo.pe', fullName: 'Z', role: 'VIEWER' }))
          .status,
      ).toBe(404);
      // Los realms siguen separados: no se crea ninguna cuenta ni invitación de empresa.
      expect((await owner.query("SELECT 1 FROM users WHERE email = 'nuevo.staff@yebo.pe'")).rowCount).toBe(0);
      expect(
        (await seed.query("SELECT 1 FROM membership_invitations WHERE email = 'nuevo.staff@yebo.pe'"))
          .rowCount,
      ).toBe(0);
    });

    it('panel: cada destino exige su permiso; destino desconocido o datos incompletos → 400', async () => {
      for (const body of [
        { target: 'STAFF', email: 'v@yebo.pe', fullName: 'V', role: 'VIEWER' },
        {
          target: 'TENANT',
          tenantId: tenant.id,
          email: 'v@primera.pe',
          roleIds: [await adminRoleOf(tenant.id)],
        },
      ]) {
        expect((await admin('post', '/api/v1/platform/invitations', body, viewer)).status).toBe(403);
      }
      for (const body of [
        { target: 'OTRO', email: 'v@yebo.pe' },
        { target: 'STAFF', email: 'v@yebo.pe', role: 'VIEWER' },
        { target: 'TENANT', tenantId: tenant.id, email: 'v@primera.pe', roleIds: [] },
      ]) {
        expect((await admin('post', '/api/v1/platform/invitations', body)).status).toBe(400);
      }
    });
  });

  describe('invitaciones de la empresa', () => {
    let tenant: Awaited<ReturnType<typeof createTenant>>;
    let adminToken = '';
    let adminRole = '';

    beforeAll(async () => {
      tenant = await createTenant('segunda');
      adminRole = await adminRoleOf(tenant.id);
      const boss = await person('jefa@segunda.pe');
      const membership = (
        await seed.query<{ id: string }>(
          `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now()) RETURNING id`,
          [tenant.id, boss.userId],
        )
      ).rows[0]?.id;
      await seed.query(
        'INSERT INTO membership_roles (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)',
        [tenant.id, membership, adminRole],
      );
      adminToken = await tenantToken(boss.identity, tenant.primaryHost);
    });

    const invite = (email: string, roleIds = [adminRole]) =>
      asTenant('post', '/api/v1/invitations', tenant.primaryHost, adminToken, { email, roleIds });

    it('la respuesta es la misma exista o no una cuenta con ese correo', async () => {
      await person('ya-existe@correo.pe');
      const a = await invite('ya-existe@correo.pe');
      const b = await invite('nadie@correo.pe');
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
      expect(a.headers['cache-control']).toBe('no-store');
    });

    it('un rol de otra empresa → 400', async () => {
      const other = await createTenant('ajena');
      expect((await invite('alguien@correo.pe', [await adminRoleOf(other.id)])).status).toBe(400);
    });

    it('con cuenta: acepta solo el titular del correo; luego el enlace ya no sirve', async () => {
      const p = await person('carla@correo.pe');
      const intruder = await person('intruso@correo.pe');
      const token = tokenOf((await invite('carla@correo.pe')).body.link);
      expect((await hub('accept', { token })).status).toBe(401); // sin sesión del hub
      expect((await hub('accept', { token }, intruder.identity)).status).toBe(403);
      // Ya tiene cuenta: crear otra con ese correo → 409 (riesgo residual aceptado: quien tiene el enlace lo sabe).
      expect((await hub('register', { token, fullName: 'Carla', password: PASSWORD })).status).toBe(409);
      const ok = await hub('accept', { token }, p.identity);
      expect(ok.status).toBe(200);
      expect(ok.body.tenantHost).toBe('segunda.yebo.pe');
      expect((await hub('accept', { token }, p.identity)).status).toBe(404);
    });

    it('dos aceptaciones simultáneas del mismo enlace: una sola gana', async () => {
      const p = await person('simultanea@correo.pe');
      const token = tokenOf((await invite('simultanea@correo.pe')).body.link);
      const results = await Promise.all([
        hub('accept', { token }, p.identity),
        hub('accept', { token }, p.identity),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    });

    it('un solo uso con bloqueo: si otra transacción la acepta mientras tanto, esta aceptación no hace nada', async () => {
      const p = await person('bloqueo@correo.pe');
      const created = await invite('bloqueo@correo.pe');
      const boss = (
        await seed.query<{ id: string }>(
          `SELECT m.id FROM tenant_memberships m JOIN users u ON u.id = m.user_id
            WHERE m.tenant_id = $1 AND u.email = 'jefa@segunda.pe'`,
          [tenant.id],
        )
      ).rows[0]?.id;
      const holder = await seed.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM membership_invitations WHERE id = $1 FOR UPDATE', [
          created.body.id,
        ]);
        const pending = hub('accept', { token: tokenOf(created.body.link) }, p.identity).then((r) => r);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await holder.query(
          'UPDATE membership_invitations SET accepted_at = now(), accepted_membership_id = $2 WHERE id = $1',
          [created.body.id, boss],
        );
        await holder.query('COMMIT');
        expect((await pending).status).toBe(404);
      } finally {
        holder.release();
      }
      expect(
        (await seed.query('SELECT 1 FROM tenant_memberships WHERE user_id = $1', [p.userId])).rowCount,
      ).toBe(0);
    });

    it('reactivar: una membresía suspendida vuelve a ACTIVE y su versión de permisos aumenta', async () => {
      const p = await person('vuelve@correo.pe');
      const m = (
        await seed.query<{ id: string }>(
          `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'SUSPENDED', now()) RETURNING id`,
          [tenant.id, p.userId],
        )
      ).rows[0]?.id;
      const token = tokenOf((await invite('vuelve@correo.pe')).body.link);
      expect((await hub('accept', { token }, p.identity)).status).toBe(200);
      const row = await seed.query(
        'SELECT status::text, permissions_version FROM tenant_memberships WHERE id = $1',
        [m],
      );
      expect(row.rows[0]).toEqual({ status: 'ACTIVE', permissions_version: 2 });
    });

    it('revocada → 404; listado con estados; otra empresa no la ve', async () => {
      const created = await invite('revocada@correo.pe');
      const revoke = await asTenant(
        'post',
        `/api/v1/invitations/${created.body.id}/revoke`,
        tenant.primaryHost,
        adminToken,
      );
      expect(revoke.status).toBe(204);
      const again = await asTenant(
        'post',
        `/api/v1/invitations/${created.body.id}/revoke`,
        tenant.primaryHost,
        adminToken,
      );
      expect(again.status).toBe(404); // ya revocada
      expect((await hub('preview', { token: tokenOf(created.body.link) })).status).toBe(404);
      const list = await asTenant('get', '/api/v1/invitations', tenant.primaryHost, adminToken);
      const statuses = new Map(
        list.body.invitations.map((i: { email: string; status: string }) => [i.email, i.status]),
      );
      expect(statuses.get('revocada@correo.pe')).toBe('REVOKED');
      expect(statuses.get('carla@correo.pe')).toBe('ACCEPTED');
      expect(statuses.get('nadie@correo.pe')).toBe('PENDING');
      const app2 = testPool('app', DB, 1);
      const client = await app2.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [
          (await seed.query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'ajena'")).rows[0]?.id,
        ]);
        expect((await client.query('SELECT 1 FROM membership_invitations')).rowCount).toBe(0);
        await client.query('ROLLBACK');
      } finally {
        client.release();
        await app2.end();
      }
    });

    it('caducada a las 72 h → 404', async () => {
      const token = tokenOf((await invite('tarde@correo.pe')).body.link);
      const saved = clock.current;
      clock.current = new Date(saved.getTime() + 72 * 3_600_000);
      expect((await hub('preview', { token })).status).toBe(404);
      clock.current = new Date(saved.getTime() + 72 * 3_600_000 - 1000);
      expect((await hub('preview', { token })).status).toBe(200);
      clock.current = saved;
    });

    it('empresa SUSPENDED: no invita (USERS_ADD) ni se acepta; con la excepción de YEBO, sí', async () => {
      const p = await person('suspendida@correo.pe');
      const token = tokenOf((await invite('suspendida@correo.pe')).body.link);
      await renewStaff();
      await admin('post', `/api/v1/platform/tenants/${tenant.id}/status`, { to: 'PAST_DUE', reason: 'Mora' });
      await admin('post', `/api/v1/platform/tenants/${tenant.id}/status`, {
        to: 'SUSPENDED',
        reason: 'Sin pago',
      });
      const denied = await invite('otra@correo.pe');
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('TENANT_RESTRICTED');
      const refused = await hub('accept', { token }, p.identity);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('TENANT_RESTRICTED');
      await admin('post', `/api/v1/platform/tenants/${tenant.id}/operation-overrides`, {
        category: 'USERS_ADD',
        validTo: new Date(clock.now().getTime() + 86_400_000).toISOString(),
        reason: 'Reemplazo del único almacenero',
      });
      expect((await hub('accept', { token }, p.identity)).status).toBe(200);
    });
  });

  it('dos cuentas nuevas simultáneas con el mismo correo (dos invitaciones): solo una se crea', async () => {
    await renewStaff();
    const t1 = await createTenant('carrera-a', 'misma@correo.pe');
    const t2 = await createTenant('carrera-b', 'misma@correo.pe');
    const results = await Promise.all([
      hub('register', {
        token: tokenOf(t1.firstAdminInvitation?.link ?? ''),
        fullName: 'Misma',
        password: PASSWORD,
      }),
      hub('register', {
        token: tokenOf(t2.firstAdminInvitation?.link ?? ''),
        fullName: 'Misma',
        password: PASSWORD,
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await owner.query("SELECT 1 FROM users WHERE email = 'misma@correo.pe'")).rowCount).toBe(1);
  });
});
