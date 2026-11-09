/**
 * Fase 4.2 · Catálogo comercial: módulos, planes y versiones inmutables al publicarse (ADR-010), excepciones de módulo
 * por tenant, módulos efectivos y `@RequiresModule` (multitenancy §6). PostgreSQL y Redis reales; reloj controlado.
 */
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import type { RequestContextStore } from '../../src/infrastructure/context/request-context';
import { MODULE_CATALOG } from '../../src/modules/access/module-catalog';
import { RolesService } from '../../src/modules/access/roles.service';
import { Protected, RequiresModule } from '../../src/modules/access/route-policy';
import { Clock } from '../../src/modules/identity/clock';
import { SessionService } from '../../src/modules/identity/session.service';
import { TenantResolverService } from '../../src/modules/tenancy/tenant-resolver.service';
import { testBypassPool, testPool } from '../support/db';
import { STAFF_CSRF, seedPlatformSession } from '../support/platform-session';

const DB = 'yebo_test';
const ADMIN = 'admin.yebo.pe';
const A = '0190f0a0-0000-7000-8000-00000000a042';
const B = '0190f0a0-0000-7000-8000-00000000b042';
const HOST_A = 'catalogo-a.yebo.test';

class FakeClock extends Clock {
  current = new Date('2026-11-10T15:00:00Z');
  now(): Date {
    return this.current;
  }
}

/** Ruta SOLO de prueba: exige el módulo CARGO (no existe en la aplicación). */
@Controller({ path: 'probe', version: '1' })
class ProbeController {
  @Get('cargo')
  @Protected('members.read', 'READ')
  @RequiresModule('CARGO')
  cargo(): { ok: true } {
    return { ok: true };
  }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

const VERSION = {
  currency: 'PEN',
  basePrice: '99.00',
  billingInterval: 'MONTHLY',
  includedUsers: 5,
  extraUserPrice: '15.00',
  modules: ['PASSENGERS', 'PARCELS'],
};

describe('Fase 4.2 · catálogo comercial y módulos efectivos', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  const clock = new FakeClock();
  const staff: Record<'super' | 'billing' | 'viewer' | 'support', string> = {
    super: '',
    billing: '',
    viewer: '',
    support: '',
  };
  let tenantToken = '';

  const http = () => request(app.getHttpServer());
  const admin = (who: keyof typeof staff, method: 'get' | 'post' | 'put', path: string, body?: object) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', staff[who]);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  const sessionModules = async (): Promise<string[]> => {
    const res = await http()
      .get('/api/v1/auth/session')
      .set('Host', HOST_A)
      .set('Cookie', `__Host-yebo_at=${tenantToken}`);
    expect(res.status).toBe(200);
    return res.body.modules;
  };

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    seed = testBypassPool(DB, 2);
    await owner.query(
      `TRUNCATE plan_version_modules, subscriptions, tenant_module_overrides, plan_versions, plans,
                platform_audit_logs, platform_setup_tokens, platform_sessions, platform_users,
                authorization_codes, refresh_tokens, tenant_sessions, identity_sessions, membership_roles,
                role_permissions, roles, tenant_memberships, users, tenant_domains, tenants CASCADE`,
    );
    // El catálogo de permisos y plantillas (3.3) lo vacían otras suites: se repone para el rol Administrador.
    await owner.query(
      `INSERT INTO permissions (id, code, module_code, description, is_sensitive, updated_at)
         SELECT gen_random_uuid(), c, 'ACCESS', c, false, now() FROM unnest(ARRAY['members.read','roles.read']) c
       ON CONFLICT (code) DO NOTHING;
       INSERT INTO role_templates (id, code, name, permission_codes, updated_at)
         VALUES (gen_random_uuid(), 'ADMIN', 'Administrador', ARRAY['members.read','roles.read'], now())
       ON CONFLICT (code) DO NOTHING;`,
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, ProbeModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(nest, parseEnv(process.env), { swagger: false });
    await nest.init();
    await nest.listen(0, '127.0.0.1');
    app = nest;
    await app.get(TenantResolverService).invalidate(HOST_A);

    staff.super = (
      await seedPlatformSession(seed, { email: 'super@yebo.pe', role: 'SUPERADMIN', now: clock.now() })
    ).cookie;
    staff.billing = (
      await seedPlatformSession(seed, { email: 'billing@yebo.pe', role: 'BILLING', now: clock.now() })
    ).cookie;
    staff.viewer = (
      await seedPlatformSession(seed, { email: 'viewer@yebo.pe', role: 'VIEWER', now: clock.now() })
    ).cookie;
    staff.support = (
      await seedPlatformSession(seed, { email: 'support@yebo.pe', role: 'SUPPORT', now: clock.now() })
    ).cookie;

    await owner.query(
      `INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id_type, tax_id, status, updated_at) VALUES
         ($1, 'catalogo-a', 'A', 'A', 'RUC', '20000000071', 'ACTIVE', now()),
         ($2, 'catalogo-b', 'B', 'B', 'RUC', '20000000072', 'ACTIVE', now())`,
      [A, B],
    );
    await owner.query(
      `INSERT INTO tenant_domains (id, tenant_id, host, kind, is_primary, verification_status, verified_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'SUBDOMAIN', true, 'VERIFIED', now(), now())`,
      [A, HOST_A],
    );
    // Persona de la empresa A con el rol Administrador (permiso members.read para la ruta de prueba).
    const user = (
      await owner.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), 'ana@a.pe', 'x', 'Ana', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0]?.id;
    const membership = (
      await seed.query<{ id: string }>(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now()) RETURNING id`,
        [A, user],
      )
    ).rows[0]?.id;
    const cls = app.get<ClsService<RequestContextStore>>(ClsService);
    const [adminRole] = await cls.run(async () => {
      cls.set('tenantId', A);
      return await app.get(RolesService).instantiateTemplates();
    });
    await seed.query('INSERT INTO membership_roles (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)', [
      A,
      membership,
      adminRole,
    ]);
    const sessions = app.get(SessionService);
    const identity = (await sessions.createIdentitySession({ userId: user ?? '', authMethods: ['pwd'] })).id;
    tenantToken = (await sessions.openTenantSession({ identitySessionId: identity, host: HOST_A }))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  it('la migración siembra exactamente el catálogo de module-catalog.ts', async () => {
    const res = await admin('viewer', 'get', '/api/v1/platform/modules');
    expect(res.status).toBe(200);
    expect(
      Object.fromEntries(
        res.body.modules.map((m: { code: string; name: string; description: string }) => [
          m.code,
          { name: m.name, description: m.description },
        ]),
      ),
    ).toEqual(MODULE_CATALOG);
  });

  it('permisos de plataforma: leer el catálogo (todos), gestionar planes (SUPERADMIN y BILLING)', async () => {
    for (const who of ['viewer', 'support', 'billing', 'super'] as const) {
      expect((await admin(who, 'get', '/api/v1/platform/plans')).status).toBe(200);
    }
    for (const who of ['viewer', 'support'] as const) {
      expect(
        (await admin(who, 'post', '/api/v1/platform/plans', { code: 'x-' + who, name: 'X' })).status,
      ).toBe(403);
    }
    expect(
      (await admin('billing', 'post', '/api/v1/platform/plans', { code: 'basico', name: 'Básico' })).status,
    ).toBe(201);
  });

  describe('planes y versiones (ADR-010)', () => {
    let planId: string;
    let v1: string;

    it('borrador → editable → publicada (inmutable) → retirada', async () => {
      const plan = await admin('billing', 'post', '/api/v1/platform/plans', {
        code: 'profesional',
        name: 'Profesional',
      });
      planId = plan.body.id;
      const created = await admin('billing', 'post', `/api/v1/platform/plans/${planId}/versions`, VERSION);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        version: 1,
        status: 'DRAFT',
        basePrice: '99.00',
        modules: ['PARCELS', 'PASSENGERS'],
      });
      expect(created.body.suspensionPolicy).toEqual({ pastDueGraceDays: 7, cancelledClosingDays: 30 });
      v1 = created.body.id;

      const edited = await admin('billing', 'put', `/api/v1/platform/plan-versions/${v1}`, {
        ...VERSION,
        basePrice: '120.50',
      });
      expect(edited.body.basePrice).toBe('120.50');

      const published = await admin('billing', 'post', `/api/v1/platform/plan-versions/${v1}/publish`);
      expect(published.status).toBe(200);
      expect(published.body.status).toBe('PUBLISHED');
      const plans = await admin('viewer', 'get', '/api/v1/platform/plans');
      expect(plans.body.plans.find((p: { id: string }) => p.id === planId).status).toBe('ACTIVE');

      expect((await admin('billing', 'put', `/api/v1/platform/plan-versions/${v1}`, VERSION)).status).toBe(
        409,
      );
      expect((await admin('billing', 'post', `/api/v1/platform/plan-versions/${v1}/publish`)).status).toBe(
        409,
      );
    });

    it('la versión siguiente lleva el número 2; sin módulos no se publica', async () => {
      const v2 = await admin('billing', 'post', `/api/v1/platform/plans/${planId}/versions`, {
        ...VERSION,
        modules: [],
      });
      expect(v2.body.version).toBe(2);
      expect(
        (await admin('billing', 'post', `/api/v1/platform/plan-versions/${v2.body.id}/publish`)).status,
      ).toBe(409);
    });

    it('validación: importe con 3 decimales, moneda inválida o módulo inexistente → 400', async () => {
      for (const bad of [
        { ...VERSION, basePrice: '9.999' },
        { ...VERSION, currency: 'soles' },
        { ...VERSION, modules: ['NO_EXISTE'] },
        { ...VERSION, limits: { branches: -1 } },
        { ...VERSION, suspensionPolicy: { pastDueGraceDays: 400 } },
      ]) {
        expect(
          (await admin('billing', 'post', `/api/v1/platform/plans/${planId}/versions`, bad)).status,
        ).toBe(400);
      }
    });

    it('el trigger de la base respalda la inmutabilidad aunque se salte la API', async () => {
      const backoffice = testPool('backoffice', DB, 1);
      try {
        for (const sql of [
          `UPDATE plan_versions SET base_price = 1 WHERE id = '${v1}'`,
          `DELETE FROM plan_versions WHERE id = '${v1}'`,
          `UPDATE plan_versions SET status = 'RETIRED', retired_at = now(), base_price = 1 WHERE id = '${v1}'`,
          `INSERT INTO plan_version_modules (plan_version_id, module_id) SELECT '${v1}', id FROM modules WHERE code = 'CARGO'`,
          `DELETE FROM plan_version_modules WHERE plan_version_id = '${v1}'`,
        ]) {
          await expect(backoffice.query(sql)).rejects.toMatchObject({
            code: expect.stringMatching(/P0001|42501/),
          });
        }
      } finally {
        await backoffice.end();
      }
    });

    it('retirar: solo una publicada, una vez', async () => {
      expect((await admin('billing', 'post', `/api/v1/platform/plan-versions/${v1}/retire`)).status).toBe(
        200,
      );
      expect((await admin('billing', 'post', `/api/v1/platform/plan-versions/${v1}/retire`)).status).toBe(
        409,
      );
    });

    it('cada cambio del catálogo queda auditado', async () => {
      const { rows } = await owner.query<{ action: string }>(
        "SELECT DISTINCT action FROM platform_audit_logs WHERE action LIKE 'plan%'",
      );
      expect(rows.map((r) => r.action).sort()).toEqual([
        'plan.created',
        'plan_version.created',
        'plan_version.published',
        'plan_version.retired',
        'plan_version.updated',
      ]);
    });
  });

  describe('módulos efectivos (plan + excepciones) y @RequiresModule', () => {
    let published: string;

    beforeAll(async () => {
      const plan = await admin('billing', 'post', '/api/v1/platform/plans', {
        code: 'operativo',
        name: 'Operativo',
      });
      const version = await admin(
        'billing',
        'post',
        `/api/v1/platform/plans/${plan.body.id}/versions`,
        VERSION,
      );
      published = version.body.id;
      await admin('billing', 'post', `/api/v1/platform/plan-versions/${published}/publish`);
      // La suscripción la crea el alta de empresas (4.3); aquí se siembra con el rol de pruebas.
      await seed.query(
        `INSERT INTO subscriptions (id, tenant_id, plan_version_id, status, current_period_start, current_period_end,
                                    is_current, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', '2026-11-01', '2026-12-01', true, now())`,
        [A, published],
      );
      // Servicios de la empresa (4.3a): los módulos de servicio del plan solo cuentan si la empresa los opera.
      await seed.query(
        `INSERT INTO tenant_services (id, tenant_id, modality, service, updated_at) VALUES
           (gen_random_uuid(), $1, 'LAND', 'PASSENGER', now()),
           (gen_random_uuid(), $1, 'RIVER', 'PARCEL', now())`,
        [A],
      );
    });

    it('sin excepciones: los módulos del plan', async () => {
      expect(await sessionModules()).toEqual(['PARCELS', 'PASSENGERS']);
      const probe = await http()
        .get('/api/v1/probe/cargo')
        .set('Host', HOST_A)
        .set('Cookie', `__Host-yebo_at=${tenantToken}`);
      expect(probe.status).toBe(403);
      expect(probe.body.error.code).toBe('MODULE_NOT_ENABLED');
    });

    it('GRANT vigente añade y vence a su fin; REVOKE futuro aún no quita; al llegar su inicio, quita', async () => {
      const grant = await admin('super', 'post', `/api/v1/platform/tenants/${A}/module-overrides`, {
        moduleCode: 'CARGO',
        effect: 'GRANT',
        reason: 'Piloto de carga',
      });
      expect(grant.status).toBe(201);
      await admin('super', 'post', `/api/v1/platform/tenants/${A}/module-overrides`, {
        moduleCode: 'PARCELS',
        effect: 'REVOKE',
        validFrom: new Date(clock.now().getTime() + 3_600_000).toISOString(),
        reason: 'Fin del servicio de encomiendas',
      });
      // GRANT con fin previsto: cuenta hasta su fin y después deja de contar sin que nadie lo termine.
      await admin('super', 'post', `/api/v1/platform/tenants/${A}/module-overrides`, {
        moduleCode: 'EINVOICING',
        effect: 'GRANT',
        validTo: new Date(clock.now().getTime() + 3_600_000).toISOString(),
        reason: 'Prueba de facturación electrónica',
      });
      expect(await sessionModules()).toEqual(['CARGO', 'EINVOICING', 'PARCELS', 'PASSENGERS']);
      const probe = await http()
        .get('/api/v1/probe/cargo')
        .set('Host', HOST_A)
        .set('Cookie', `__Host-yebo_at=${tenantToken}`);
      expect(probe.status).toBe(200);

      clock.current = new Date(clock.now().getTime() + 2 * 3_600_000);
      // Las sesiones sembradas del staff caducan por inactividad (30 min): se renuevan con la hora nueva.
      staff.super = (
        await seedPlatformSession(seed, { email: 'super2@yebo.pe', role: 'SUPERADMIN', now: clock.now() })
      ).cookie;
      staff.viewer = (
        await seedPlatformSession(seed, { email: 'viewer2@yebo.pe', role: 'VIEWER', now: clock.now() })
      ).cookie;
      const sessions = app.get(SessionService);
      const refreshed = await http()
        .get('/api/v1/auth/session')
        .set('Host', HOST_A)
        .set('Cookie', `__Host-yebo_at=${tenantToken}`);
      if (refreshed.status !== 200) {
        // El access token caducó con el avance del reloj: se abre otra sesión para seguir midiendo.
        const userId =
          (await owner.query<{ id: string }>("SELECT id FROM users WHERE email = 'ana@a.pe'")).rows[0]?.id ??
          '';
        const identity = (await sessions.createIdentitySession({ userId, authMethods: ['pwd'] })).id;
        tenantToken = (await sessions.openTenantSession({ identitySessionId: identity, host: HOST_A }))
          .accessToken;
      }
      expect(await sessionModules()).toEqual(['CARGO', 'PASSENGERS']);
    });

    it('REVOKE gana sobre GRANT; una excepción terminada deja de contar', async () => {
      const revoke = await admin('super', 'post', `/api/v1/platform/tenants/${A}/module-overrides`, {
        moduleCode: 'CARGO',
        effect: 'REVOKE',
        reason: 'Suspensión temporal del piloto',
      });
      expect(await sessionModules()).toEqual(['PASSENGERS']);
      expect(
        (await admin('super', 'post', `/api/v1/platform/tenants/${A}/module-overrides/${revoke.body.id}/end`))
          .status,
      ).toBe(204);
      expect(await sessionModules()).toEqual(['CARGO', 'PASSENGERS']);
      expect(
        (await admin('super', 'post', `/api/v1/platform/tenants/${A}/module-overrides/${revoke.body.id}/end`))
          .status,
      ).toBe(404);
    });

    it('las excepciones son del tenant: B no ve las de A, ni con la API ni con yebo_app (RLS)', async () => {
      expect(
        (await admin('viewer', 'get', `/api/v1/platform/tenants/${A}/module-overrides`)).body.overrides
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await admin('viewer', 'get', `/api/v1/platform/tenants/${B}/module-overrides`)).body.overrides,
      ).toEqual([]);
      const appPool = testPool('app', DB, 1);
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [B]);
        expect((await client.query('SELECT 1 FROM tenant_module_overrides')).rowCount).toBe(0);
        expect((await client.query('SELECT 1 FROM subscriptions')).rowCount).toBe(0);
        await client.query('ROLLBACK');
      } finally {
        client.release();
        await appPool.end();
      }
    });

    it('excepciones: VIEWER no las crea; tenant inexistente → 404; fin anterior al inicio → 400', async () => {
      expect(
        (
          await admin('viewer', 'post', `/api/v1/platform/tenants/${A}/module-overrides`, {
            moduleCode: 'CARGO',
            effect: 'GRANT',
            reason: 'x x x',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await admin(
            'super',
            'post',
            '/api/v1/platform/tenants/0190f0a0-0000-7000-8000-0000000000ff/module-overrides',
            { moduleCode: 'CARGO', effect: 'GRANT', reason: 'Prueba' },
          )
        ).status,
      ).toBe(404);
      const now = clock.now().getTime();
      expect(
        (
          await admin('super', 'post', `/api/v1/platform/tenants/${A}/module-overrides`, {
            moduleCode: 'CARGO',
            effect: 'GRANT',
            reason: 'Prueba',
            validFrom: new Date(now + 1000).toISOString(),
            validTo: new Date(now).toISOString(),
          })
        ).status,
      ).toBe(400);
    });
  });
});
