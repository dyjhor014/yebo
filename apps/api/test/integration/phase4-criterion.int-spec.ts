/**
 * Fase 4.8 · Criterio de aceptación de la Fase 4 (roadmap): «crear empresa, asignar plan, medir usuarios y
 * calcular el importe», de extremo a extremo por la API real y con el reloj de la aplicación avanzando día a día.
 *
 *   staff: plan publicado → alta de la empresa con ese plan y su primer administrador
 *   empresa: el administrador acepta (crea su cuenta en el hub) e invita, suspende y reactiva personas por la API
 *   cada noche: los mismos jobs del worker, en su orden (snapshots de los días terminados → cierre de períodos)
 *   cierre: factura con el importe de billing §5 (pico diario); vencimiento → PAST_DUE; pago → «Al día».
 *
 * Escenario (zona de la empresa: America/Lima; período del 1 al 31 de octubre de 2026):
 *   1 oct: administrador + 5 personas = 6 · 10 oct: +4 = 10 · 15 oct: se suspenden 3 = 7 · 20 oct: vuelve 1 = 8
 *   · 25 oct: reemplazo en el mismo instante (sale una persona y entra otra a las 10:00) = sigue en 8.
 *   Pico diario del período = 10; incluidos 5 → 5 adicionales × S/ 15.00 + base S/ 99.00 = S/ 174.00.
 *
 * El calendario simulado y el historial: los triggers de membership_status_history fechan con el reloj de
 * PostgreSQL (now()), como en producción, donde coincide con el de la aplicación. Aquí la aplicación vive en un
 * mes PASADO (octubre de 2026), de modo que el reloj de PostgreSQL va siempre por delante del simulado y los
 * intervalos que cierra el trigger son válidos; tras cada acción, `at(t, …)` traslada al instante simulado `t` las
 * fechas que esa acción acaba de escribir, con el guardián del historial desactivado solo en esa transacción.
 * Es lo mismo que hace el fixture de billing.int-spec al insertar el historial con fechas explícitas.
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
import { Clock } from '../../src/modules/identity/clock';
import { SessionService } from '../../src/modules/identity/session.service';
import { MeteringPrismaService } from '../../src/modules/metering/metering-prisma.service';
import { MeteringService } from '../../src/modules/metering/metering.service';
import { PeriodClosingService } from '../../src/modules/metering/period-closing.service';
import { TenantLifecycleService } from '../../src/modules/platform-admin/tenant-lifecycle.service';
import { RESET_TENANT_DATA, testBypassPool, testPool } from '../support/db';
import { STAFF_CSRF, seedPlatformSession } from '../support/platform-session';

const DB = 'yebo_test';
const ADMIN = 'admin.yebo.pe';
const HUB = 'cuentas.yebo.pe';
const CSRF = 'csrf-de-prueba-0123456789abcdef';
const PASSWORD = 'rios-claros-del-amazonas-2026';

class FakeClock extends Clock {
  current = new Date('2026-10-01T14:00:00Z'); // 09:00 del 1 de octubre en Lima
  now(): Date {
    return this.current;
  }
}
/** Instante UTC de una hora de Lima (UTC−5, sin horario de verano). */
const lima = (day: string, hhmm = '09:00') => new Date(`${day}T${hhmm}:00-05:00`);

describe('Fase 4.8 · criterio de la Fase 4: crear empresa, asignar plan, medir usuarios y calcular el importe', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let metering: MeteringPrismaService;
  let usage: MeteringService;
  let closing: PeriodClosingService;
  const clock = new FakeClock();
  let staff = '';
  let tenantId = '';
  let host = '';
  let adminUserId = '';
  let adminRoleId = '';
  const members = new Map<string, string>(); // correo → membershipId

  const http = () => request(app.getHttpServer());
  const asStaff = (method: 'get' | 'post', path: string, body?: object) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', staff);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  const renewStaff = async () => {
    staff = (
      await seedPlatformSession(seed, {
        email: `cobros-${clock.now().getTime()}@yebo.pe`,
        role: 'SUPERADMIN',
        now: clock.now(),
      })
    ).cookie;
  };
  /** Sesión de empresa del administrador, abierta con el reloj actual (las sesiones caducan al avanzar los días). */
  const asAdmin = async (method: 'get' | 'post', path: string, body?: object) => {
    const sessions = app.get(SessionService);
    const identity = (await sessions.createIdentitySession({ userId: adminUserId, authMethods: ['pwd'] })).id;
    const token = (await sessions.openTenantSession({ identitySessionId: identity, host })).accessToken;
    const agent = http();
    let req = agent[method](path)
      .set('Host', host)
      .set('Cookie', `__Host-yebo_at=${token}; __Host-yebo_csrf=${CSRF}`);
    if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
    return body ? req.send(body) : req;
  };
  const register = (link: string, fullName: string) =>
    http()
      .post('/api/v1/hub/invitations/register')
      .set('Host', HUB)
      .set('Cookie', `__Host-yebo_csrf=${CSRF}`)
      .set('X-CSRF-Token', CSRF)
      .send({ token: link.split('#')[1] ?? '', fullName, password: PASSWORD });
  /** La empresa invita a una persona y esta crea su cuenta desde el enlace: membresía ACTIVE desde ese momento. */
  const join = async (email: string) => {
    const inv = await asAdmin('post', '/api/v1/invitations', { email, roleIds: [adminRoleId] });
    expect(inv.status).toBe(201);
    expect((await register(inv.body.link, `Persona ${email}`)).status).toBe(200);
    const id = (
      await seed.query<{ id: string }>(
        `SELECT m.id FROM tenant_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND u.email = $2`,
        [tenantId, email],
      )
    ).rows[0]?.id as string;
    members.set(email, id);
  };
  /**
   * Ejecuta `action` en el instante simulado `at` y lleva a ese instante las fechas que escribió en el historial
   * (ver la cabecera). Así un intervalo empieza o termina exactamente cuando ocurrió en el calendario simulado.
   */
  const at = async (when: Date, action: () => Promise<void>) => {
    clock.current = when;
    const realStart = (await seed.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]?.t as Date;
    await action();
    // Como el fixture de billing.int-spec: el guardián del historial se desactiva solo en esta transacción.
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE membership_status_history DISABLE TRIGGER membership_status_history_guard');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await c.query('UPDATE membership_status_history SET valid_to = $1 WHERE valid_to >= $2', [
        when,
        realStart,
      ]);
      await c.query('UPDATE membership_status_history SET valid_from = $1 WHERE valid_from >= $2', [
        when,
        realStart,
      ]);
      await c.query('ALTER TABLE membership_status_history ENABLE TRIGGER membership_status_history_guard');
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  };
  /** La noche de cada día: lo mismo que UsageMeteringProcessor.process() en el worker. */
  const nightlyJobs = async () => {
    await usage.runDue();
    await closing.runDue();
  };
  /** Avanza el reloj noche a noche (00:16 en Lima) hasta `day` inclusive, ejecutando los jobs cada noche. */
  const advanceTo = async (day: string) => {
    let d = new Date(clock.now().getTime());
    while (true) {
      const next = new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const iso = next.toISOString().slice(0, 10);
      if (iso > day) break;
      clock.current = lima(iso, '00:16');
      await nightlyJobs();
      d = next;
    }
  };

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    seed = testBypassPool(DB, 2);
    await owner.query(
      `TRUNCATE subscription_payments, platform_invoice_lines, platform_invoices, usage_period_calculations,
                billing_periods, usage_daily_snapshots, plan_version_modules, plan_versions, plans,
                platform_audit_logs, platform_setup_tokens, platform_sessions, platform_users CASCADE`,
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(nest, parseEnv(process.env), { swagger: false });
    await nest.init();
    app = nest;
    const redis = app.get(RedisService);
    const keys = await redis.client.keys('rl:*');
    if (keys.length > 0) await redis.client.del(...keys);
    // Los jobs del worker, con el rol yebo_metering y el mismo reloj que la API.
    metering = new MeteringPrismaService(parseEnv({ ...process.env, PG_DATABASE: DB }));
    usage = new MeteringService(metering, clock);
    closing = new PeriodClosingService(metering, clock);
    await renewStaff();
  });

  afterAll(async () => {
    await app.close();
    await metering.onModuleDestroy();
    await Promise.all([owner.end(), seed.end()]);
  });

  it('1 · el staff publica un plan y da de alta la empresa con ese plan y su primer administrador', async () => {
    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'criterio', name: 'Criterio' });
    expect(plan.status).toBe(201);
    const version = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
      basePrice: '99.00',
      billingInterval: 'MONTHLY',
      includedUsers: 5,
      extraUserPrice: '15.00',
      usageMetric: 'PEAK_DAILY',
      dailyAggregation: 'PEAK_CONCURRENT',
      trialDays: 0,
      paymentTermsDays: 7,
      modules: ['PASSENGERS'],
    });
    expect(version.status).toBe(201);
    expect((await asStaff('post', `/api/v1/platform/plan-versions/${version.body.id}/publish`)).status).toBe(
      200,
    );

    const created = await asStaff('post', '/api/v1/platform/tenants', {
      slug: 'criterio-fase-4',
      legalName: 'Transportes Criterio S.A.C.',
      tradeName: 'Transportes Criterio',
      taxIdType: 'RUC',
      taxId: '20600000004',
      planVersionId: version.body.id,
      services: [{ modality: 'LAND', service: 'PASSENGER' }],
      firstAdminEmail: 'gerencia@criterio.pe',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'ACTIVE',
      subscription: {
        planVersionId: version.body.id,
        currentPeriodStart: '2026-10-01',
        currentPeriodEnd: '2026-11-01',
      },
    });
    tenantId = created.body.id;
    host = created.body.primaryHost;

    // El administrador crea su cuenta desde el enlace (hub) y queda como miembro activo.
    await at(lima('2026-10-01', '09:00'), async () => {
      expect((await register(created.body.firstAdminInvitation.link, 'Gerencia Criterio')).status).toBe(200);
    });
    adminUserId = (
      await seed.query<{ id: string }>("SELECT id FROM users WHERE email = 'gerencia@criterio.pe'")
    ).rows[0]?.id as string;
    adminRoleId = (
      await seed.query<{ id: string }>(
        "SELECT id FROM roles WHERE tenant_id = $1 AND name = 'Administrador'",
        [tenantId],
      )
    ).rows[0]?.id as string;
    expect(adminUserId).toBeTruthy();
    expect(adminRoleId).toBeTruthy();
  });

  it('2 · la empresa gestiona sus usuarios durante el mes y cada noche se miden los días terminados', async () => {
    // 1 oct: el administrador invita a 5 personas → 6 usuarios.
    await at(lima('2026-10-01', '10:00'), async () => {
      for (let i = 1; i <= 5; i++) await join(`persona${i}@criterio.pe`);
    });
    // 10 oct: 4 personas más → 10.
    await advanceTo('2026-10-10');
    await at(lima('2026-10-10', '10:00'), async () => {
      for (let i = 6; i <= 9; i++) await join(`persona${i}@criterio.pe`);
    });
    // 15 oct: se suspende a 3 → 7 (USERS_REDUCE siempre permitido).
    await advanceTo('2026-10-15');
    await at(lima('2026-10-15', '10:00'), async () => {
      for (const i of [1, 2, 3]) {
        const res = await asAdmin(
          'post',
          `/api/v1/members/${members.get(`persona${i}@criterio.pe`)}/suspend`,
        );
        expect(res.status).toBe(200);
      }
    });
    // 20 oct: vuelve 1 → 8.
    await advanceTo('2026-10-20');
    await at(lima('2026-10-20', '10:00'), async () => {
      expect(
        (await asAdmin('post', `/api/v1/members/${members.get('persona1@criterio.pe')}/reactivate`)).status,
      ).toBe(200);
    });
    // 25 oct: reemplazo en la misma operación (billing §3): a las 10:00 sale una persona y entra otra → sigue en 8.
    await advanceTo('2026-10-25');
    await at(lima('2026-10-25', '10:00'), async () => {
      expect(
        (await asAdmin('post', `/api/v1/members/${members.get('persona6@criterio.pe')}/suspend`)).status,
      ).toBe(200);
      await join('persona10@criterio.pe');
    });
    // Noches hasta el 31: antes del cierre, el período sigue abierto y sin factura.
    await advanceTo('2026-10-31');
    expect(
      (await seed.query('SELECT 1 FROM platform_invoices WHERE tenant_id = $1', [tenantId])).rowCount,
    ).toBe(0);

    await renewStaff();
    const res = await asStaff(
      'get',
      `/api/v1/platform/tenants/${tenantId}/usage?from=2026-10-01&to=2026-10-30`,
    );
    expect(res.status).toBe(200);
    const peak = Object.fromEntries(
      (res.body.days as { date: string; peakConcurrent: number; status: string }[]).map((d) => [
        d.date,
        d.peakConcurrent,
      ]),
    );
    expect(res.body.days).toHaveLength(30); // del 1 al 30 cerrados (el 31 se cierra esta noche)
    expect(res.body.days.every((d: { status: string }) => d.status === 'FINAL')).toBe(true);
    expect([peak['2026-10-01'], peak['2026-10-09'], peak['2026-10-10'], peak['2026-10-14']]).toEqual([
      6, 6, 10, 10,
    ]);
    expect([
      peak['2026-10-15'],
      peak['2026-10-16'],
      peak['2026-10-19'],
      peak['2026-10-20'],
      peak['2026-10-30'],
    ]).toEqual([10, 7, 7, 8, 8]);
    // El reemplazo no suma: en el mismo instante, las salidas cuentan antes que las entradas.
    expect([peak['2026-10-24'], peak['2026-10-25'], peak['2026-10-26']]).toEqual([8, 8, 8]);
  });

  it('3 · al cerrar el período: factura de S/ 174.00 (base 99 + 5 adicionales × 15), una sola vez', async () => {
    await advanceTo('2026-11-01'); // la noche del 31 al 1: último snapshot y cierre del período
    await nightlyJobs(); // repetir no crea nada
    const invoices = await seed.query<{
      id: string;
      code: string;
      total: string;
      balance: string;
      status: string;
      issue: string;
      due: string;
    }>(
      `SELECT id, code, total::text, balance::text, status::text, issue_date::text AS issue, due_date::text AS due
         FROM platform_invoices WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(invoices.rows).toEqual([
      expect.objectContaining({
        total: '174.00',
        balance: '174.00',
        status: 'ISSUED',
        issue: '2026-11-01',
        due: '2026-11-08',
      }),
    ]);
    const calc = await seed.query(
      `SELECT metric_value, included_users, extra_users, base_amount::text, extra_amount::text, total_amount::text
         FROM usage_period_calculations WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(calc.rows).toEqual([
      {
        metric_value: 10,
        included_users: 5,
        extra_users: 5,
        base_amount: '99.00',
        extra_amount: '75.00',
        total_amount: '174.00',
      },
    ]);
    // El staff la ve en el panel (lista y ficha) y la empresa en «Obligaciones con YEBO».
    await renewStaff();
    const list = await asStaff('get', '/api/v1/platform/tenants');
    expect(list.body.tenants.find((t: { id: string }) => t.id === tenantId)).toMatchObject({
      plan: { name: 'Criterio', version: 1 },
      outstanding: '174.00',
      overdue: false,
      milestone: { kind: 'PERIOD_ENDS', date: '2026-11-30' },
    });
    const billing = await asStaff('get', `/api/v1/platform/tenants/${tenantId}/billing`);
    expect(
      billing.body.invoices[0].lines.map((l: { kind: string; quantity: number; amount: string }) => [
        l.kind,
        l.quantity,
        l.amount,
      ]),
    ).toEqual([
      ['BASE', 1, '99.00'],
      ['EXTRA_USERS', 5, '75.00'],
    ]);
    const own = await asAdmin('get', '/api/v1/billing/obligations');
    expect(own.status).toBe(200);
    expect(own.body.outstanding).toEqual([{ currency: 'PEN', amount: '174.00' }]);
  });

  it('4 · sin pagar al vencer: PAST_DUE; al registrar el pago en el panel, la empresa vuelve a «Al día»', async () => {
    await advanceTo('2026-11-09');
    await app.get(TenantLifecycleService).runDue();
    expect((await seed.query('SELECT status::text FROM tenants WHERE id = $1', [tenantId])).rows).toEqual([
      { status: 'PAST_DUE' },
    ]);
    await renewStaff();
    const invoiceId = (
      await seed.query<{ id: string }>('SELECT id FROM platform_invoices WHERE tenant_id = $1', [tenantId])
    ).rows[0]?.id as string;
    const paid = await asStaff(
      'post',
      `/api/v1/platform/tenants/${tenantId}/invoices/${invoiceId}/payments`,
      {
        amount: '174.00',
        method: 'BANK_TRANSFER',
        reference: 'OP-CRITERIO-174',
      },
    );
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ invoice: { status: 'PAID', balance: '0.00' }, tenantStatus: 'ACTIVE' });
  });
});
