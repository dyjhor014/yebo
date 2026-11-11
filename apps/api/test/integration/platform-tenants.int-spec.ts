/**
 * Fase 4.3a · Alta de empresas y máquina de estados del tenant: alta atómica con subdominio resoluble, subdominios
 * reservados (MKT-D6), módulos efectivos ∩ servicios, transiciones con historial que la matriz aplica sin esperar a
 * la caché, excepción temporal de USERS_ADD y job de estados. PostgreSQL y Redis reales; reloj controlado.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { PERMISSION_CODES } from '../../src/modules/access/permission-catalog';
import { Clock } from '../../src/modules/identity/clock';
import { SessionService } from '../../src/modules/identity/session.service';
import { TenantLifecycleService } from '../../src/modules/platform-admin/tenant-lifecycle.service';
import { TENANT_LIFECYCLE_QUEUE } from '../../src/modules/platform-admin/tenant-lifecycle.worker';
import { TenantResolverService } from '../../src/modules/tenancy/tenant-resolver.service';
import { WorkerModule } from '../../src/worker.module';
import { testBypassPool, testPool } from '../support/db';
import { STAFF_CSRF, seedPlatformSession } from '../support/platform-session';

const DB = 'yebo_test';
const ADMIN = 'admin.yebo.pe';
const CSRF = 'csrf-de-prueba-0123456789abcdef';
const DAY = 86_400_000;

class FakeClock extends Clock {
  current = new Date('2026-11-10T15:00:00Z');
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

describe('Fase 4.3a · alta de empresas y estados del tenant', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  const clock = new FakeClock();
  const staff = { super: '', viewer: '' };
  let trialVersion = '';
  let directVersion = '';
  let draftVersion = '';

  const http = () => request(app.getHttpServer());
  const admin = (who: keyof typeof staff, method: 'get' | 'post', path: string, body?: object) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', staff[who]);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  let renewals = 0;
  const renewStaff = async () => {
    const n = (renewals += 1);
    staff.super = (
      await seedPlatformSession(seed, { email: `super-${n}@yebo.pe`, role: 'SUPERADMIN', now: clock.now() })
    ).cookie;
    staff.viewer = (
      await seedPlatformSession(seed, { email: `viewer-${n}@yebo.pe`, role: 'VIEWER', now: clock.now() })
    ).cookie;
  };
  const newTenant = (slug: string, planVersionId: string, extra: object = {}) =>
    admin('super', 'post', '/api/v1/platform/tenants', {
      slug,
      legalName: `${slug} SAC`,
      tradeName: slug,
      taxId: `20${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      planVersionId,
      services: [{ modality: 'LAND', service: 'PASSENGER' }],
      ...extra,
    });
  const setStatus = (tenantId: string, to: string, reason = 'Cambio de prueba') =>
    admin('super', 'post', `/api/v1/platform/tenants/${tenantId}/status`, { to, reason });

  /** Administrador de la empresa con sesión abierta (rol de sistema creado por el alta). */
  const signInAdmin = async (tenantId: string, host: string): Promise<string> => {
    const user = (
      await owner.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), $1, 'x', 'Admin', 'ACTIVE', now()) RETURNING id`,
        [`admin@${host}`],
      )
    ).rows[0]?.id as string;
    const membership = (
      await seed.query<{ id: string }>(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now()) RETURNING id`,
        [tenantId, user],
      )
    ).rows[0]?.id;
    await seed.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id)
       SELECT $1, $2, id FROM roles WHERE tenant_id = $1 AND name = 'Administrador'`,
      [tenantId, membership],
    );
    const sessions = app.get(SessionService);
    const identity = (await sessions.createIdentitySession({ userId: user, authMethods: ['pwd'] })).id;
    return (await sessions.openTenantSession({ identitySessionId: identity, host })).accessToken;
  };
  /** Ruta con USERS_ADD: si los guards dejan pasar, el id inexistente da 404; si el estado lo impide, 403. */
  const usersAdd = (host: string, token: string) =>
    http()
      .post('/api/v1/members/0190f0a0-0000-7000-8000-0000000000ff/reactivate')
      .set('Host', host)
      .set('Cookie', `__Host-yebo_at=${token}; __Host-yebo_csrf=${CSRF}`)
      .set('X-CSRF-Token', CSRF);

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    seed = testBypassPool(DB, 2);
    await owner.query(
      `TRUNCATE plan_version_modules, subscriptions, tenant_module_overrides, plan_versions, plans,
                tenant_settings, tenant_services, tenant_status_history, tenant_operation_overrides,
                platform_audit_logs, platform_setup_tokens, platform_sessions, platform_users,
                authorization_codes, refresh_tokens, tenant_sessions, identity_sessions, membership_roles,
                role_permissions, roles, tenant_memberships, users, tenant_domains, tenants CASCADE`,
    );
    // Catálogo de permisos y plantilla ADMIN completos (otras suites los vacían).
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
    await renewStaff();

    const plan = async (code: string, version: object, publish = true): Promise<string> => {
      const p = await admin('super', 'post', '/api/v1/platform/plans', { code, name: code });
      const v = await admin('super', 'post', `/api/v1/platform/plans/${p.body.id}/versions`, {
        basePrice: '99.00',
        billingInterval: 'MONTHLY',
        includedUsers: 5,
        extraUserPrice: '15.00',
        ...version,
      });
      if (publish) await admin('super', 'post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
      return v.body.id;
    };
    trialVersion = await plan('prueba', { trialDays: 14, modules: ['PASSENGERS', 'PARCELS', 'EINVOICING'] });
    directVersion = await plan('directo', {
      trialDays: 0,
      billingInterval: 'QUARTERLY',
      suspensionPolicy: { pastDueGraceDays: 3, cancelledClosingDays: 30 },
      modules: ['PASSENGERS'],
    });
    draftVersion = await plan('borrador', { modules: ['PASSENGERS'] }, false);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  describe('alta', () => {
    it('deja un subdominio resoluble al instante (aunque estuviera en la caché negativa) y todo lo necesario', async () => {
      const host = 'transportes-sol.yebo.pe';
      expect((await http().get('/api/v1/public/site').set('Host', host)).status).toBe(404);

      const res = await newTenant('Transportes-Sol', trialVersion, {
        services: [
          { modality: 'LAND', service: 'PASSENGER' },
          { modality: 'RIVER', service: 'CARGO' },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        slug: 'transportes-sol',
        status: 'TRIAL',
        primaryHost: host,
        trialEndsAt: new Date(clock.now().getTime() + 14 * DAY).toISOString(),
        domains: [{ host, kind: 'SUBDOMAIN', isPrimary: true, verificationStatus: 'VERIFIED' }],
        // 10:00 en Lima: el período empieza el día local y dura un mes.
        subscription: {
          planVersionId: trialVersion,
          status: 'TRIALING',
          currentPeriodStart: '2026-11-10',
          currentPeriodEnd: '2026-12-10',
        },
        statusHistory: [{ fromStatus: null, toStatus: 'TRIAL', reason: 'Alta de la empresa' }],
      });
      expect(res.body.services).toHaveLength(2);

      const site = await http().get('/api/v1/public/site').set('Host', host);
      expect(site.status).toBe(200);

      const id = res.body.id as string;
      const [settings, roles, audit] = await Promise.all([
        seed.query('SELECT 1 FROM tenant_settings WHERE tenant_id = $1', [id]),
        seed.query(
          `SELECT r.is_system, count(rp.*)::int AS n FROM roles r
             LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.tenant_id = $1 GROUP BY r.id`,
          [id],
        ),
        seed.query("SELECT 1 FROM platform_audit_logs WHERE action = 'tenant.created' AND tenant_id = $1", [
          id,
        ]),
      ]);
      expect(settings.rowCount).toBe(1);
      expect(roles.rows).toEqual([{ is_system: true, n: PERMISSION_CODES.length }]);
      expect(audit.rowCount).toBe(1);
    });

    it('el período se calcula en la zona horaria de la empresa y ajusta el fin de mes', async () => {
      const saved = clock.current;
      clock.current = new Date('2027-01-31T15:00:00Z');
      await renewStaff();
      const res = await newTenant('fin-de-mes', trialVersion, { timezone: 'Pacific/Auckland' });
      // 04:00 del 1 de febrero en Auckland.
      expect(res.body.subscription).toMatchObject({
        currentPeriodStart: '2027-02-01',
        currentPeriodEnd: '2027-03-01',
      });
      clock.current = new Date('2027-01-31T12:00:00Z');
      await renewStaff();
      const lima = await newTenant('fin-de-mes-lima', trialVersion);
      expect(lima.body.subscription).toMatchObject({
        currentPeriodStart: '2027-01-31',
        currentPeriodEnd: '2027-02-28',
      });
      clock.current = saved;
      await renewStaff();
    });

    it('un plan sin trial nace ACTIVE con su suscripción ACTIVE', async () => {
      const res = await newTenant('directo-sa', directVersion);
      expect(res.body).toMatchObject({
        status: 'ACTIVE',
        trialEndsAt: null,
        subscription: { status: 'ACTIVE' },
      });
      expect(res.body.activatedAt).toBe(clock.now().toISOString());
    });

    it('subdominios reservados (MKT-D6) y etiquetas de la plataforma → 400', async () => {
      for (const slug of ['www', 'cuentas', 'admin', 'API', 'estado', 'static']) {
        const res = await newTenant(slug, trialVersion);
        expect({ slug, status: res.status }).toEqual({ slug, status: 400 });
      }
      expect(
        (await seed.query("SELECT 1 FROM tenants WHERE slug IN ('www','cuentas','admin','api')")).rowCount,
      ).toBe(0);
    });

    it('slug o documento repetidos → 409; versión no publicada o inexistente → 409 / 400', async () => {
      expect((await newTenant('transportes-sol', trialVersion)).status).toBe(409);
      const first = await newTenant('doc-unico', trialVersion, { taxId: '20999999991' });
      expect(first.status).toBe(201);
      expect((await newTenant('doc-otro', trialVersion, { taxId: '20999999991' })).status).toBe(409);
      expect((await newTenant('sin-publicar', draftVersion)).status).toBe(409);
      expect((await newTenant('sin-version', '0190f0a0-0000-7000-8000-0000000000ee')).status).toBe(400);
      expect(
        (await seed.query("SELECT 1 FROM tenants WHERE slug IN ('sin-publicar','doc-otro')")).rowCount,
      ).toBe(0);
    });

    it('dos altas simultáneas del mismo slug: una sola gana, sin restos de la otra', async () => {
      const [a, b] = await Promise.all([
        newTenant('carrera', trialVersion),
        newTenant('carrera', trialVersion),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect((await seed.query("SELECT 1 FROM tenant_domains WHERE host = 'carrera.yebo.pe'")).rowCount).toBe(
        1,
      );
    });

    it('VIEWER lista y consulta, pero no da de alta; un id inexistente → 404', async () => {
      const list = await admin('viewer', 'get', '/api/v1/platform/tenants');
      expect(list.status).toBe(200);
      expect(list.body.tenants.map((t: { slug: string }) => t.slug)).toContain('transportes-sol');
      const res = await admin('viewer', 'post', '/api/v1/platform/tenants', {
        slug: 'vista',
        legalName: 'x',
        tradeName: 'x',
        taxId: '20111111111',
        planVersionId: trialVersion,
        services: [{ modality: 'LAND', service: 'PASSENGER' }],
      });
      expect(res.status).toBe(403);
      expect(
        (await admin('viewer', 'get', '/api/v1/platform/tenants/0190f0a0-0000-7000-8000-0000000000ee'))
          .status,
      ).toBe(404);
    });
  });

  describe('módulos efectivos ∩ servicios de la empresa', () => {
    it('un módulo de servicio del plan solo cuenta si la empresa opera el servicio', async () => {
      const res = await newTenant('solo-pasajeros', trialVersion);
      const token = await signInAdmin(res.body.id, 'solo-pasajeros.yebo.pe');
      const session = await http()
        .get('/api/v1/auth/session')
        .set('Host', 'solo-pasajeros.yebo.pe')
        .set('Cookie', `__Host-yebo_at=${token}`);
      // Plan: PASSENGERS, PARCELS y EINVOICING. Servicios: solo pasajeros. EINVOICING no depende de servicios.
      expect(session.body.modules).toEqual(['EINVOICING', 'PASSENGERS']);
    });
  });

  describe('máquina de estados', () => {
    let id = '';
    let host = '';
    let token = '';

    beforeAll(async () => {
      const res = await newTenant('estados', directVersion);
      id = res.body.id;
      host = res.body.primaryHost;
      token = await signInAdmin(id, host);
    });

    it('cada transición se aplica en la matriz en la petición siguiente, sin esperar a la caché', async () => {
      expect((await usersAdd(host, token)).status).toBe(404); // ACTIVE: pasa los guards (caché caliente)
      expect((await setStatus(id, 'PAST_DUE', 'Factura vencida')).status).toBe(200);
      expect((await usersAdd(host, token)).status).toBe(404); // PAST_DUE: USERS_ADD sigue permitido
      const suspended = await setStatus(id, 'SUSPENDED', 'Sin pago');
      expect(suspended.body).toMatchObject({ status: 'SUSPENDED', subscription: { status: 'SUSPENDED' } });
      const denied = await usersAdd(host, token);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('TENANT_RESTRICTED');
      expect((await app.get(TenantResolverService).resolve(host))?.status).toBe('SUSPENDED');
    });

    it('USERS_ADD con excepción temporal de YEBO; al terminarla vuelve a denegarse', async () => {
      const override = await admin('super', 'post', `/api/v1/platform/tenants/${id}/operation-overrides`, {
        category: 'USERS_ADD',
        validTo: new Date(clock.now().getTime() + 2 * DAY).toISOString(),
        reason: 'Reemplazo del único almacenero',
      });
      expect(override.status).toBe(201);
      expect((await usersAdd(host, token)).status).toBe(404);
      expect(
        (
          await admin(
            'super',
            'post',
            `/api/v1/platform/tenants/${id}/operation-overrides/${override.body.id}/end`,
          )
        ).status,
      ).toBe(204);
      expect((await usersAdd(host, token)).status).toBe(403);
    });

    it('una excepción cuyo fin ya pasó no cuenta', async () => {
      const now = clock.now().getTime();
      const expired = await admin('super', 'post', `/api/v1/platform/tenants/${id}/operation-overrides`, {
        category: 'USERS_ADD',
        validFrom: new Date(now - 2 * 3_600_000).toISOString(),
        validTo: new Date(now - 3_600_000).toISOString(),
        reason: 'Excepción ya vencida',
      });
      expect(expired.status).toBe(201);
      expect((await usersAdd(host, token)).status).toBe(403);
    });

    it('la excepción no aplica a otras categorías: CONFIGURE sigue denegado en SUSPENDED', async () => {
      await admin('super', 'post', `/api/v1/platform/tenants/${id}/operation-overrides`, {
        category: 'USERS_ADD',
        validTo: new Date(clock.now().getTime() + DAY).toISOString(),
        reason: 'Excepción vigente',
      });
      const roles = await http()
        .put('/api/v1/members/0190f0a0-0000-7000-8000-0000000000ff/roles')
        .set('Host', host)
        .set('Cookie', `__Host-yebo_at=${token}; __Host-yebo_csrf=${CSRF}`)
        .set('X-CSRF-Token', CSRF)
        .send({ roleIds: [] });
      expect(roles.status).toBe(403);
      expect(roles.body.error.code).toBe('TENANT_RESTRICTED');
    });

    it('excepción: más de 30 días o fin anterior → 400; VIEWER no la crea', async () => {
      const now = clock.now().getTime();
      for (const validTo of [now + 31 * DAY, now - 1000]) {
        const res = await admin('super', 'post', `/api/v1/platform/tenants/${id}/operation-overrides`, {
          category: 'USERS_ADD',
          validTo: new Date(validTo).toISOString(),
          reason: 'Prueba',
        });
        expect(res.status).toBe(400);
      }
      expect(
        (
          await admin('viewer', 'post', `/api/v1/platform/tenants/${id}/operation-overrides`, {
            category: 'USERS_ADD',
            validTo: new Date(now + DAY).toISOString(),
            reason: 'Prueba',
          })
        ).status,
      ).toBe(403);
    });

    it('transiciones no permitidas → 409; CANCELLED es final y la excepción no lo salva', async () => {
      expect((await setStatus(id, 'PAST_DUE')).status).toBe(409); // SUSPENDED → PAST_DUE
      expect((await setStatus(id, 'TRIAL')).status).toBe(409);
      expect((await setStatus(id, 'CANCELLED', 'Baja solicitada')).status).toBe(200);
      expect((await usersAdd(host, token)).status).toBe(403); // periodo de cierre, con excepción vigente
      expect((await setStatus(id, 'ACTIVE')).status).toBe(409);
      const detail = await admin('viewer', 'get', `/api/v1/platform/tenants/${id}`);
      expect(detail.body.cancelledAt).toBe(clock.now().toISOString());
      expect(detail.body.statusHistory.map((h: { toStatus: string }) => h.toStatus)).toEqual([
        'ACTIVE',
        'PAST_DUE',
        'SUSPENDED',
        'CANCELLED',
      ]);
      expect(
        (
          await seed.query(
            "SELECT 1 FROM platform_audit_logs WHERE action = 'tenant.status_changed' AND tenant_id = $1",
            [id],
          )
        ).rowCount,
      ).toBe(3);
    });

    it('el historial es append-only: el trigger rechaza UPDATE y DELETE aunque se salte el RLS', async () => {
      await expect(
        seed.query('UPDATE tenant_status_history SET reason = $1', ['otro motivo']),
      ).rejects.toMatchObject({
        code: 'P0001',
      });
      await expect(seed.query('DELETE FROM tenant_status_history')).rejects.toMatchObject({ code: 'P0001' });
      const backoffice = testPool('backoffice', DB, 1);
      try {
        await expect(backoffice.query('DELETE FROM tenant_status_history')).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await backoffice.end();
      }
    });
  });

  describe('job de estados (worker)', () => {
    it('TRIAL → EXPIRED al vencer el trial y PAST_DUE → SUSPENDED tras la gracia del plan; idempotente', async () => {
      const trial = (await newTenant('job-trial', trialVersion)).body.id as string;
      const pastDue = (await newTenant('job-mora', directVersion)).body.id as string;
      await setStatus(pastDue, 'PAST_DUE', 'Factura vencida');
      const lifecycle = app.get(TenantLifecycleService);
      const statusOf = async (tid: string) =>
        (
          await owner.query<{ status: string }>('SELECT status::text AS status FROM tenants WHERE id = $1', [
            tid,
          ])
        ).rows[0]?.status;

      clock.advance(3 * DAY - 1); // la gracia del plan «directo» es de 3 días
      await lifecycle.runDue();
      expect(await statusOf(pastDue)).toBe('PAST_DUE');
      clock.advance(1);
      await lifecycle.runDue();
      expect(await statusOf(pastDue)).toBe('SUSPENDED');
      expect(await statusOf(trial)).toBe('TRIAL');

      clock.advance(11 * DAY); // 14 días de trial
      // Dos ejecuciones simultáneas (réplicas del worker): una sola transición y una sola fila de historial.
      await Promise.all([lifecycle.runDue(), lifecycle.runDue()]);
      expect(await lifecycle.runDue()).toBe(0);
      expect(await statusOf(trial)).toBe('EXPIRED');
      const history = await seed.query<{ to_status: string; actor: string | null; reason: string }>(
        `SELECT to_status::text, actor_platform_user_id AS actor, reason FROM tenant_status_history
          WHERE tenant_id = $1 ORDER BY occurred_at`,
        [trial],
      );
      expect(history.rows.map((r) => [r.to_status, r.actor])).toEqual([
        ['TRIAL', expect.any(String)],
        ['EXPIRED', null],
      ]);
      const sub = await seed.query(
        'SELECT status::text FROM subscriptions WHERE tenant_id = $1 AND is_current',
        [trial],
      );
      expect(sub.rows).toEqual([{ status: 'EXPIRED' }]);
    });

    it('el job no aplica una evaluación obsoleta: si el estado cambió entretanto, no hace nada', async () => {
      await renewStaff(); // la prueba anterior avanzó el reloj 14 días
      const tid = (await newTenant('job-obsoleto', directVersion)).body.id as string;
      await setStatus(tid, 'PAST_DUE', 'Primera mora');
      const evaluated = (
        await owner.query<{ at: Date }>('SELECT status_changed_at AS at FROM tenants WHERE id = $1', [tid])
      ).rows[0]?.at as Date;
      // Mientras el job evaluaba, la empresa pagó y volvió a entrar en mora: la gracia empieza de nuevo.
      clock.advance(60_000);
      await renewStaff();
      await setStatus(tid, 'ACTIVE', 'Pago registrado');
      clock.advance(60_000);
      await renewStaff();
      await setStatus(tid, 'PAST_DUE', 'Segunda mora');
      const applied = await app.get(TenantLifecycleService).transition({
        tenantId: tid,
        to: 'SUSPENDED',
        reason: 'Fin de los días de gracia sin regularizar el pago',
        actorPlatformUserId: null,
        expect: { status: 'PAST_DUE', statusChangedAt: evaluated },
      });
      expect(applied).toBe(false);
      expect((await owner.query('SELECT status::text FROM tenants WHERE id = $1', [tid])).rows[0]).toEqual({
        status: 'PAST_DUE',
      });
    });

    it('el worker registra un único planificador repetible del job', async () => {
      const ref = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
      const worker = ref.createNestApplication({ bufferLogs: true });
      await worker.init();
      try {
        const queue = worker.get<Queue>(getQueueToken(TENANT_LIFECYCLE_QUEUE));
        const schedulers = await queue.getJobSchedulers();
        expect(schedulers.filter((s) => s.key === 'tenant-lifecycle-run-due')).toHaveLength(1);
      } finally {
        await worker.close();
      }
    });
  });
});
