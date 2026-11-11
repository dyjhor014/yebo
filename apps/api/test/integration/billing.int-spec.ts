/**
 * Fase 4.5 · Períodos, importe y cobro (billing §5–8): cierre del período con todos los días, las tres métricas,
 * importe y factura, inmutabilidad tras el cierre, trial sin factura, pagos manuales, vencimiento → PAST_DUE y
 * reactivación al pagar, y la vista «Obligaciones con YEBO» de la empresa. PostgreSQL y Redis reales.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { Clock } from '../../src/modules/identity/clock';
import { SessionService } from '../../src/modules/identity/session.service';
import { MeteringPrismaService } from '../../src/modules/metering/metering-prisma.service';
import { PeriodClosingService } from '../../src/modules/metering/period-closing.service';
import { TenantLifecycleService } from '../../src/modules/platform-admin/tenant-lifecycle.service';
import { testBypassPool, testPool } from '../support/db';
import { STAFF_CSRF, seedPlatformSession } from '../support/platform-session';

const DB = 'yebo_test';
const ADMIN = 'admin.yebo.pe';
const CSRF = 'csrf-de-prueba-0123456789abcdef';

class FakeClock extends Clock {
  current = new Date('2026-11-01T05:16:00Z');
  now(): Date {
    return this.current;
  }
}

let seq = 0;
const uuid = () => `0190f0a0-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

describe('Fase 4.5 · períodos, importe y cobro', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let metering: MeteringPrismaService;
  const clock = new FakeClock();
  let closing: PeriodClosingService;

  const fixture = async (tenantId: string, fn: (c: PoolClient) => Promise<void>) => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE tenant_memberships DISABLE TRIGGER tenant_memberships_status_history');
      await c.query('ALTER TABLE membership_status_history DISABLE TRIGGER membership_status_history_guard');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await fn(c);
      await c.query('ALTER TABLE tenant_memberships ENABLE TRIGGER tenant_memberships_status_history');
      await c.query('ALTER TABLE membership_status_history ENABLE TRIGGER membership_status_history_guard');
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  };
  /** n personas facturables en [from, to). */
  const people = async (c: PoolClient, tenantId: string, n: number, from: string, to: string | null) => {
    for (let i = 0; i < n; i += 1) {
      const userId = uuid();
      const membershipId = uuid();
      await c.query(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES ($1, $2, 'x', 'P', 'ACTIVE', now())`,
        [userId, `p${seq}@cobro.pe`],
      );
      await c.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at) VALUES ($1, $2, $3, 'ACTIVE', now())`,
        [membershipId, tenantId, userId],
      );
      await c.query(
        `INSERT INTO membership_status_history (tenant_id, membership_id, user_id, status, billable, user_active,
                                                effective_billable, valid_from, valid_to, changed_by_kind)
         VALUES ($1, $2, $3, 'ACTIVE', true, true, true, $4, $5, 'SYSTEM')`,
        [tenantId, membershipId, userId, from, to],
      );
    }
  };
  /** Empresa con suscripción de octubre 2026 a un plan (99 base, 5 incluidos, 15 por adicional, 7 días). */
  const company = async (opts: { metric?: string; trial?: boolean; host?: string; grace?: number } = {}) => {
    const tenantId = uuid();
    const planId = uuid();
    const versionId = uuid();
    await owner.query(
      `INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id_type, tax_id, status, timezone, updated_at)
       VALUES ($1, $2, 'Cobro SAC', 'Cobro', 'RUC', $3, $4, 'America/Lima', now())`,
      [tenantId, `cobro-${seq}`, `20${String(seq).padStart(9, '0')}`, opts.trial ? 'TRIAL' : 'ACTIVE'],
    );
    if (opts.host) {
      await owner.query(
        `INSERT INTO tenant_domains (id, tenant_id, host, kind, is_primary, verification_status, verified_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'SUBDOMAIN', true, 'VERIFIED', now(), now())`,
        [tenantId, opts.host],
      );
    }
    await owner.query(
      `INSERT INTO plans (id, code, name, status, updated_at) VALUES ($1, $2, 'P', 'ACTIVE', now())`,
      [planId, `plan-${seq}`],
    );
    await owner.query(
      `INSERT INTO plan_versions (id, plan_id, version, status, currency, base_price, billing_interval, included_users,
                                  extra_user_price, usage_metric, payment_terms_days, suspension_policy,
                                  published_at, updated_at)
       VALUES ($1, $2, 1, 'PUBLISHED', 'PEN', 99, 'MONTHLY', 5, 15, $3, 7, $4, now(), now())`,
      [
        versionId,
        planId,
        opts.metric ?? 'PEAK_DAILY',
        JSON.stringify(opts.grace === undefined ? {} : { pastDueGraceDays: opts.grace }),
      ],
    );
    await seed.query(
      `INSERT INTO subscriptions (id, tenant_id, plan_version_id, status, current_period_start, current_period_end,
                                  is_current, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, '2026-10-01', '2026-11-01', true, now())`,
      [tenantId, versionId, opts.trial ? 'TRIALING' : 'ACTIVE'],
    );
    // 5 personas todo el mes y 7 más solo el 15/10 (Lima): pico 12 ese día, 5 el resto.
    await fixture(tenantId, async (c) => {
      await people(c, tenantId, 5, '2026-10-01T05:00Z', null);
      await people(c, tenantId, 7, '2026-10-15T05:00Z', '2026-10-16T05:00Z');
    });
    return tenantId;
  };
  const q = async <T extends object>(sql: string, params: unknown[] = []) =>
    (await seed.query<T>(sql, params)).rows;
  const close = (tenantId: string, at: string) => closing.closeTenant(tenantId, new Date(at));

  beforeAll(async () => {
    owner = testPool('owner', DB, 3);
    seed = testBypassPool(DB, 3);
    await owner.query(
      `TRUNCATE subscription_payments, platform_invoice_lines, platform_invoices, usage_period_calculations,
                billing_periods, usage_daily_snapshots, membership_status_history, membership_invitations,
                plan_version_modules, subscriptions, tenant_module_overrides, plan_versions, plans, tenant_settings,
                tenant_services, tenant_status_history, tenant_operation_overrides, platform_audit_logs,
                platform_setup_tokens, platform_sessions, platform_users, authorization_codes, refresh_tokens,
                tenant_sessions, identity_sessions, membership_roles, role_permissions, roles, tenant_memberships,
                users, tenant_domains, tenants CASCADE`,
    );
    metering = new MeteringPrismaService(parseEnv({ ...process.env, PG_DATABASE: DB }));
    closing = new PeriodClosingService(metering, clock);
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    const nest = ref.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(nest, parseEnv(process.env), { swagger: false });
    await nest.init();
    app = nest;
  });

  afterAll(async () => {
    await app.close();
    await metering.onModuleDestroy();
    await Promise.all([owner.end(), seed.end()]);
  });

  describe('cierre del período (billing §6)', () => {
    let t = '';

    beforeAll(async () => {
      t = await company();
    });

    it('antes de los 15 min tras el fin del período no cierra; después, cierra con todos los días', async () => {
      expect(await close(t, '2026-11-01T05:14:00Z')).toBe(0);
      expect(await q('SELECT status::text FROM billing_periods WHERE tenant_id = $1', [t])).toEqual([
        { status: 'OPEN' },
      ]);
      expect(await close(t, '2026-11-01T05:16:00Z')).toBe(1);
      expect(
        (
          await q<{ n: number }>(
            'SELECT count(*)::int AS n FROM usage_daily_snapshots WHERE tenant_id = $1',
            [t],
          )
        )[0]?.n,
      ).toBe(31);
    });

    it('la fórmula de §5: pico 12, 5 incluidos → 7 adicionales → 204.00, con la copia de la versión de plan', async () => {
      const [calc] = await q<Record<string, unknown>>(
        `SELECT metric_value, included_users, extra_users, base_amount::text, extra_amount::text, total_amount::text,
                (plan_version_snapshot ->> 'base_price')::numeric(14,2)::text AS snap_base, jsonb_array_length(daily_series) AS days,
                pricing ->> 'source' AS source
           FROM usage_period_calculations WHERE tenant_id = $1`,
        [t],
      );
      expect(calc).toEqual({
        metric_value: 12,
        included_users: 5,
        extra_users: 7,
        base_amount: '99.00',
        extra_amount: '105.00',
        total_amount: '204.00',
        snap_base: '99.00',
        days: 31,
        source: 'PLAN',
      });
    });

    it('factura emitida con sus líneas, vencimiento a 7 días; suscripción avanzada y período siguiente abierto', async () => {
      const [inv] = await q<Record<string, unknown>>(
        `SELECT status::text, to_char(issue_date, 'YYYY-MM-DD') AS issue, to_char(due_date, 'YYYY-MM-DD') AS due,
                total::text, balance::text, code FROM platform_invoices WHERE tenant_id = $1`,
        [t],
      );
      expect(inv).toMatchObject({
        status: 'ISSUED',
        issue: '2026-11-01',
        due: '2026-11-08',
        total: '204.00',
        balance: '204.00',
      });
      expect(inv?.code).toMatch(/^YB-202611-[0-9A-F]{8}$/);
      expect(
        await q(
          'SELECT kind::text, quantity, unit_price::text, amount::text FROM platform_invoice_lines WHERE tenant_id = $1 ORDER BY kind',
          [t],
        ),
      ).toEqual([
        { kind: 'BASE', quantity: 1, unit_price: '99.00', amount: '99.00' },
        { kind: 'EXTRA_USERS', quantity: 7, unit_price: '15.00', amount: '105.00' },
      ]);
      expect(
        await q(
          `SELECT to_char(current_period_start, 'YYYY-MM-DD') AS s, to_char(current_period_end, 'YYYY-MM-DD') AS e
             FROM subscriptions WHERE tenant_id = $1`,
          [t],
        ),
      ).toEqual([{ s: '2026-11-01', e: '2026-12-01' }]);
      expect(
        await q(
          `SELECT to_char(period_start, 'YYYY-MM-DD') AS s, status::text FROM billing_periods WHERE tenant_id = $1 ORDER BY period_start`,
          [t],
        ),
      ).toEqual([
        { s: '2026-10-01', status: 'CLOSED' },
        { s: '2026-11-01', status: 'OPEN' },
      ]);
    });

    it('repetir el cierre no crea nada; revocar usuarios después no altera la factura', async () => {
      expect(await close(t, '2026-11-02T00:00:00Z')).toBe(0);
      await seed.query("UPDATE tenant_memberships SET status = 'REVOKED' WHERE tenant_id = $1", [t]);
      expect(await close(t, '2026-11-02T01:00:00Z')).toBe(0);
      expect(
        await q('SELECT total::text, balance::text FROM platform_invoices WHERE tenant_id = $1', [t]),
      ).toEqual([{ total: '204.00', balance: '204.00' }]);
      expect(
        (
          await q<{ n: number }>(
            'SELECT count(*)::int AS n FROM usage_period_calculations WHERE tenant_id = $1',
            [t],
          )
        )[0]?.n,
      ).toBe(1);
    });

    it('cerrado, nada se modifica: período, cálculo, líneas e importes de la factura (aunque se salte el RLS)', async () => {
      for (const sql of [
        "UPDATE billing_periods SET timezone = 'UTC' WHERE tenant_id = $1 AND status = 'CLOSED'",
        "UPDATE billing_periods SET status = 'OPEN' WHERE tenant_id = $1 AND status = 'CLOSED'",
        'DELETE FROM billing_periods WHERE tenant_id = $1',
        'UPDATE usage_period_calculations SET metric_value = 1 WHERE tenant_id = $1',
        'DELETE FROM usage_period_calculations WHERE tenant_id = $1',
        'UPDATE platform_invoice_lines SET amount = 1 WHERE tenant_id = $1',
        'UPDATE platform_invoices SET total = 1, subtotal = 1 WHERE tenant_id = $1',
        'DELETE FROM platform_invoices WHERE tenant_id = $1',
        'UPDATE usage_daily_snapshots SET peak_concurrent = 1 WHERE tenant_id = $1',
      ]) {
        await expect(seed.query(sql, [t])).rejects.toMatchObject({ code: 'P0001' });
      }
    });

    it('las métricas AVERAGE_DAILY (ceil 162/31 = 6) y END_OF_PERIOD (5)', async () => {
      const avg = await company({ metric: 'AVERAGE_DAILY' });
      const end = await company({ metric: 'END_OF_PERIOD' });
      await close(avg, '2026-11-01T05:16:00Z');
      await close(end, '2026-11-01T05:16:00Z');
      const row = async (id: string) =>
        (
          await q<{ v: number; total: string }>(
            'SELECT metric_value AS v, total_amount::text AS total FROM usage_period_calculations WHERE tenant_id = $1',
            [id],
          )
        )[0];
      expect(await row(avg)).toEqual({ v: 6, total: '114.00' });
      expect(await row(end)).toEqual({ v: 5, total: '99.00' });
    });

    it('un período de prueba se calcula pero no se factura', async () => {
      const trial = await company({ trial: true });
      expect(await close(trial, '2026-11-01T05:16:00Z')).toBe(1);
      expect((await q('SELECT 1 FROM usage_period_calculations WHERE tenant_id = $1', [trial])).length).toBe(
        1,
      );
      expect(await q('SELECT 1 FROM platform_invoices WHERE tenant_id = $1', [trial])).toEqual([]);
      expect(
        await q('SELECT is_trial FROM billing_periods WHERE tenant_id = $1 ORDER BY period_start LIMIT 1', [
          trial,
        ]),
      ).toEqual([{ is_trial: true }]);
    });

    it('la excepción comercial de la suscripción entra en el cálculo y queda registrada', async () => {
      const t2 = await company();
      await seed.query(
        `UPDATE subscriptions SET price_override = '{"includedUsers": 10, "reason": "Acuerdo de lanzamiento"}' WHERE tenant_id = $1`,
        [t2],
      );
      await close(t2, '2026-11-01T05:16:00Z');
      expect(
        await q(
          "SELECT total_amount::text AS total, pricing ->> 'overrideReason' AS reason FROM usage_period_calculations WHERE tenant_id = $1",
          [t2],
        ),
      ).toEqual([{ total: '129.00', reason: 'Acuerdo de lanzamiento' }]);
    });
  });

  describe('cobro, vencimiento y reactivación', () => {
    let t = '';
    let invoiceId = '';
    let billing = '';
    let viewer = '';
    let tenantCookie = '';
    const pay = (amount: string, who = billing) =>
      request(app.getHttpServer())
        .post(`/api/v1/platform/tenants/${t}/invoices/${invoiceId}/payments`)
        .set('Host', ADMIN)
        .set('Cookie', who)
        .set('X-CSRF-Token', STAFF_CSRF)
        .send({ amount, method: 'BANK_TRANSFER', reference: `OP-${amount}` });

    beforeAll(async () => {
      t = await company({ host: 'cobro-empresa.yebo.test' });
      await close(t, '2026-11-01T05:16:00Z');
      invoiceId =
        (await q<{ id: string }>('SELECT id FROM platform_invoices WHERE tenant_id = $1', [t]))[0]?.id ?? '';
      clock.current = new Date('2026-11-01T06:00:00Z');
      billing = (
        await seedPlatformSession(seed, { email: 'cobros@yebo.pe', role: 'BILLING', now: clock.now() })
      ).cookie;
      viewer = (await seedPlatformSession(seed, { email: 'mira@yebo.pe', role: 'VIEWER', now: clock.now() }))
        .cookie;
    });

    it('pago parcial → PARTIALLY_PAID; superar el saldo → 400; VIEWER no registra pagos', async () => {
      expect((await pay('10.00', viewer)).status).toBe(403);
      const partial = await pay('100.00');
      expect(partial.status).toBe(201);
      expect(partial.body.invoice).toMatchObject({ status: 'PARTIALLY_PAID', balance: '104.00' });
      expect(partial.body.invoice.payments).toHaveLength(1);
      expect((await pay('104.01')).status).toBe(400);
      const future = await request(app.getHttpServer())
        .post(`/api/v1/platform/tenants/${t}/invoices/${invoiceId}/payments`)
        .set('Host', ADMIN)
        .set('Cookie', billing)
        .set('X-CSRF-Token', STAFF_CSRF)
        .send({ amount: '1.00', method: 'CASH', reference: 'R-1', paidAt: '2026-11-01T06:01:00Z' });
      expect(future.status).toBe(400); // un minuto después del reloj: fecha futura
      expect(await q('SELECT balance::text FROM platform_invoices WHERE id = $1', [invoiceId])).toEqual([
        { balance: '104.00' },
      ]);
    });

    it('al vencer sin pagar: factura OVERDUE y empresa PAST_DUE (job de estados)', async () => {
      clock.current = new Date('2026-11-08T23:00:00Z'); // 18:00 del 8 en Lima: aún no vence
      await app.get(TenantLifecycleService).runDue();
      expect(await q('SELECT status::text FROM platform_invoices WHERE id = $1', [invoiceId])).toEqual([
        { status: 'PARTIALLY_PAID' },
      ]);
      clock.current = new Date('2026-11-09T06:00:00Z'); // 9 en Lima
      await app.get(TenantLifecycleService).runDue();
      expect(await q('SELECT status::text FROM platform_invoices WHERE id = $1', [invoiceId])).toEqual([
        { status: 'OVERDUE' },
      ]);
      expect(await q('SELECT status::text FROM tenants WHERE id = $1', [t])).toEqual([
        { status: 'PAST_DUE' },
      ]);
    });

    it('la lista del panel (4.7) muestra plan, saldo, vencimiento y el día de la suspensión en hora de la empresa', async () => {
      // PAST_DUE desde las 01:00 del 9 en Lima; gracia por defecto de 7 días → se suspende el 16 (hora de Lima).
      const fresh = (
        await seedPlatformSession(seed, { email: 'mira2@yebo.pe', role: 'VIEWER', now: clock.now() })
      ).cookie; // el reloj avanzó 8 días: la sesión anterior ya caducó
      const res = await request(app.getHttpServer())
        .get('/api/v1/platform/tenants')
        .set('Host', ADMIN)
        .set('Cookie', fresh);
      expect(res.status).toBe(200);
      const row = res.body.tenants.find((x: { id: string }) => x.id === t);
      expect(row).toMatchObject({
        status: 'PAST_DUE',
        plan: { name: 'P', version: 1 },
        includedUsers: 5,
        usersPeak: null, // período nuevo sin días cerrados
        outstanding: '104.00',
        overdue: true,
        currency: 'PEN',
        milestone: { kind: 'SUSPENDS_ON', date: '2026-11-16' },
      });
      // Una empresa al día (sin facturas): saldo 0.00, sin vencimiento; el hito es el último día de su período.
      const ok = await company();
      const again = await request(app.getHttpServer())
        .get('/api/v1/platform/tenants')
        .set('Host', ADMIN)
        .set('Cookie', fresh);
      expect(again.body.tenants.find((x: { id: string }) => x.id === ok)).toMatchObject({
        status: 'ACTIVE',
        outstanding: '0.00',
        overdue: false,
        milestone: { kind: 'PERIOD_ENDS', date: '2026-10-31' },
      });
      // Vencida a las 22:00 del 8 en Lima (03:00 UTC del 9) con 3 días de gracia en su plan → se suspende el 11
      // (hora de Lima). Leída en UTC daría el 12; con la gracia por defecto, el 15.
      const late = await company({ grace: 3 });
      await owner.query(
        "UPDATE tenants SET status = 'PAST_DUE', status_changed_at = '2026-11-09T03:00:00Z' WHERE id = $1",
        [late],
      );
      const third = await request(app.getHttpServer())
        .get('/api/v1/platform/tenants')
        .set('Host', ADMIN)
        .set('Cookie', fresh);
      expect(third.body.tenants.find((x: { id: string }) => x.id === late).milestone).toEqual({
        kind: 'SUSPENDS_ON',
        date: '2026-11-11',
      });
      // Suspendida a las 23:30 del 10 en Lima (04:30 UTC del 11): «Suspendida desde el 10».
      await owner.query(
        "UPDATE tenants SET status = 'SUSPENDED', status_changed_at = '2026-11-11T04:30:00Z' WHERE id = $1",
        [late],
      );
      const fourth = await request(app.getHttpServer())
        .get('/api/v1/platform/tenants')
        .set('Host', ADMIN)
        .set('Cookie', fresh);
      expect(fourth.body.tenants.find((x: { id: string }) => x.id === late).milestone).toEqual({
        kind: 'SUSPENDED_SINCE',
        date: '2026-11-10',
      });
      // Una factura anulada no cuenta como saldo pendiente ni como vencida (se restaura para las pruebas siguientes).
      await seed.query("UPDATE platform_invoices SET status = 'VOID' WHERE id = $1", [invoiceId]);
      try {
        const voided = await request(app.getHttpServer())
          .get('/api/v1/platform/tenants')
          .set('Host', ADMIN)
          .set('Cookie', fresh);
        expect(voided.body.tenants.find((x: { id: string }) => x.id === t)).toMatchObject({
          outstanding: '0.00',
          overdue: false,
        });
      } finally {
        await seed.query("UPDATE platform_invoices SET status = 'OVERDUE' WHERE id = $1", [invoiceId]);
      }
    });

    it('pagar el saldo vencido reactiva la empresa en la misma operación, con historial y auditoría', async () => {
      billing = (
        await seedPlatformSession(seed, { email: 'cobros2@yebo.pe', role: 'BILLING', now: clock.now() })
      ).cookie;
      const res = await pay('104.00');
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        invoice: { status: 'PAID', balance: '0.00' },
        tenantStatus: 'ACTIVE',
      });
      expect(
        await q(
          `SELECT from_status::text, to_status::text, reason FROM tenant_status_history WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
          [t],
        ),
      ).toEqual([
        { from_status: 'PAST_DUE', to_status: 'ACTIVE', reason: 'Pago registrado: sin saldo vencido' },
      ]);
      expect(
        (
          await q("SELECT 1 FROM platform_audit_logs WHERE action = 'payment.recorded' AND tenant_id = $1", [
            t,
          ])
        ).length,
      ).toBe(2);
      expect((await pay('1.00')).status).toBe(409); // ya pagada
    });

    it('«Obligaciones con YEBO»: la empresa ve sus facturas y pagos; otra empresa, no', async () => {
      const userId = uuid();
      const membershipId = uuid();
      const roleId = uuid();
      await seed.query(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at) VALUES ($1, 'jefa@cobro.pe', 'x', 'Jefa', 'ACTIVE', now())`,
        [userId],
      );
      await seed.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at) VALUES ($1, $2, $3, 'ACTIVE', now())`,
        [membershipId, t, userId],
      );
      await seed.query(
        `INSERT INTO roles (id, tenant_id, name, is_system, updated_at) VALUES ($1, $2, 'Finanzas', false, now())`,
        [roleId, t],
      );
      await seed.query(
        `INSERT INTO permissions (id, code, module_code, description, is_sensitive, updated_at)
         VALUES (gen_random_uuid(), 'billing.read', 'ACCESS', 'x', false, now()) ON CONFLICT (code) DO NOTHING`,
      );
      await seed.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE code = 'billing.read'`,
        [t, roleId],
      );
      await seed.query(
        'INSERT INTO membership_roles (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)',
        [t, membershipId, roleId],
      );
      const sessions = app.get(SessionService);
      const identity = (await sessions.createIdentitySession({ userId, authMethods: ['pwd'] })).id;
      const token = (
        await sessions.openTenantSession({ identitySessionId: identity, host: 'cobro-empresa.yebo.test' })
      ).accessToken;
      tenantCookie = `__Host-yebo_at=${token}; __Host-yebo_csrf=${CSRF}`;
      const res = await request(app.getHttpServer())
        .get('/api/v1/billing/obligations')
        .set('Host', 'cobro-empresa.yebo.test')
        .set('Cookie', tenantCookie);
      expect(res.status).toBe(200);
      expect(res.body.invoices).toHaveLength(1);
      expect(res.body.invoices[0]).toMatchObject({ status: 'PAID', total: '204.00' });
      expect(res.body.invoices[0].payments).toHaveLength(2);
      expect(res.body.outstanding).toEqual([]);
      expect(res.body.currentPeriod).toEqual({
        periodStart: '2026-11-01',
        periodEnd: '2026-12-01',
        isTrial: false,
      });
      // Otra empresa (RLS con yebo_app): ninguna factura ajena.
      const other = await company();
      await close(other, '2026-11-01T05:16:00Z');
      const appPool = testPool('app', DB, 1);
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [other]);
        expect((await c.query('SELECT tenant_id FROM platform_invoices')).rows).toEqual([
          { tenant_id: other },
        ]);
        await c.query('ROLLBACK');
      } finally {
        c.release();
        await appPool.end();
      }
    });

    describe('anulación de pagos (4.7b, decisiones del 2026-11-10)', () => {
      const reverse = (paymentId: string, reason: string, who = billing) =>
        request(app.getHttpServer())
          .post(`/api/v1/platform/tenants/${t}/payments/${paymentId}/reverse`)
          .set('Host', ADMIN)
          .set('Cookie', who)
          .set('X-CSRF-Token', STAFF_CSRF)
          .send({ reason });
      const lastPayment = async () =>
        (
          await q<{ id: string }>(
            'SELECT id FROM subscription_payments WHERE invoice_id = $1 ORDER BY created_at DESC LIMIT 1',
            [invoiceId],
          )
        )[0]?.id ?? '';

      it('VIEWER no anula; motivo corto → 400; pago inexistente o de otra empresa → 404', async () => {
        const id = await lastPayment();
        viewer = (
          await seedPlatformSession(seed, { email: 'mira3@yebo.pe', role: 'VIEWER', now: clock.now() })
        ).cookie;
        expect((await reverse(id, 'Rebote del banco', viewer)).status).toBe(403);
        expect((await reverse(id, 'no')).status).toBe(400);
        expect((await reverse('0190f0a0-0000-7000-8000-0000000000ee', 'Rebote del banco')).status).toBe(404);
        expect((await reverse('no-es-uuid', 'Rebote del banco')).status).toBe(404);
        const other = await company();
        expect(
          (
            await request(app.getHttpServer())
              .post(`/api/v1/platform/tenants/${other}/payments/${id}/reverse`)
              .set('Host', ADMIN)
              .set('Cookie', billing)
              .set('X-CSRF-Token', STAFF_CSRF)
              .send({ reason: 'Rebote del banco' })
          ).status,
        ).toBe(404); // el RLS de la otra empresa no lo ve
        expect(await q('SELECT status::text FROM subscription_payments WHERE id = $1', [id])).toEqual([
          { status: 'CONFIRMED' },
        ]);
      });

      it('anular el pago que la reactivó: saldo repuesto, factura vencida y la empresa vuelve a PAST_DUE', async () => {
        const id = await lastPayment();
        const res = await reverse(id, 'Rebote del banco: operación OP-104.00');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          invoice: { status: 'OVERDUE', balance: '104.00' },
          tenantStatus: 'PAST_DUE',
        });
        const reversed = res.body.invoice.payments.find((p: { id: string }) => p.id === id);
        expect(reversed).toMatchObject({
          status: 'REVERSED',
          reversedAt: clock.now().toISOString(),
          reversalReason: 'Rebote del banco: operación OP-104.00',
        });
        expect(
          await q(
            `SELECT from_status::text, to_status::text, reason FROM tenant_status_history
              WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
            [t],
          ),
        ).toEqual([
          {
            from_status: 'ACTIVE',
            to_status: 'PAST_DUE',
            reason: 'Pago anulado: la factura vuelve a tener saldo vencido',
          },
        ]);
        expect(
          await q(
            "SELECT detail->>'reason' AS reason FROM platform_audit_logs WHERE action = 'payment.reversed' AND target_id = $1",
            [id],
          ),
        ).toEqual([{ reason: 'Rebote del banco: operación OP-104.00' }]);
        expect((await reverse(id, 'Otra vez')).status).toBe(409);
        // La empresa ve la anulación, pero no el motivo interno del staff.
        const own = await request(app.getHttpServer())
          .get('/api/v1/billing/obligations')
          .set('Host', 'cobro-empresa.yebo.test')
          .set('Cookie', tenantCookie);
        const seen = own.body.invoices[0].payments.find((p: { id: string }) => p.id === id);
        expect(seen.reversedAt).toBe(clock.now().toISOString());
        expect(seen).not.toHaveProperty('reversalReason');
        expect(own.body.outstanding).toEqual([{ currency: 'PEN', amount: '104.00' }]);
        // Volver a pagar el saldo la reactiva de nuevo.
        expect((await pay('104.00')).body.tenantStatus).toBe('ACTIVE');
      });

      it('antes del vencimiento: la factura vuelve a emitida o parcial y la empresa no cambia de estado', async () => {
        const saved = clock.current;
        clock.current = new Date('2026-11-01T05:16:00Z');
        const fresh = await company({ host: 'anula-antes.yebo.test' });
        await close(fresh, '2026-11-01T05:16:00Z');
        const inv = (
          await q<{ id: string }>('SELECT id FROM platform_invoices WHERE tenant_id = $1', [fresh])
        )[0]!.id;
        // 23:00 del 8 en Lima (ya el 9 en UTC): es el día del vencimiento, todavía no está vencida.
        clock.current = new Date('2026-11-09T04:00:00Z');
        const who = (
          await seedPlatformSession(seed, { email: 'cobros3@yebo.pe', role: 'BILLING', now: clock.now() })
        ).cookie;
        const payFresh = (amount: string) =>
          request(app.getHttpServer())
            .post(`/api/v1/platform/tenants/${fresh}/invoices/${inv}/payments`)
            .set('Host', ADMIN)
            .set('Cookie', who)
            .set('X-CSRF-Token', STAFF_CSRF)
            .send({ amount, method: 'CASH', reference: `R-${amount}` });
        const p1 = (await payFresh('50.00')).body.invoice.payments[0].id as string;
        const p2 = (await payFresh('154.00')).body.invoice.payments[1].id as string;
        const reverseFresh = (id: string) =>
          request(app.getHttpServer())
            .post(`/api/v1/platform/tenants/${fresh}/payments/${id}/reverse`)
            .set('Host', ADMIN)
            .set('Cookie', who)
            .set('X-CSRF-Token', STAFF_CSRF)
            .send({ reason: 'Registrado por error' });
        const a = await reverseFresh(p2);
        expect(a.body).toMatchObject({
          invoice: { status: 'PARTIALLY_PAID', balance: '154.00' },
          tenantStatus: 'ACTIVE',
        });
        const b = await reverseFresh(p1);
        expect(b.body).toMatchObject({
          invoice: { status: 'ISSUED', balance: '204.00' },
          tenantStatus: 'ACTIVE',
        });
        expect(
          (
            await q("SELECT 1 FROM tenant_status_history WHERE tenant_id = $1 AND to_status = 'PAST_DUE'", [
              fresh,
            ])
          ).length,
        ).toBe(0);
        // Los pagos de una factura anulada no se anulan.
        const p3 = (await payFresh('10.00')).body.invoice.payments[2].id as string;
        await seed.query("UPDATE platform_invoices SET status = 'VOID' WHERE id = $1", [inv]);
        try {
          expect((await reverseFresh(p3)).status).toBe(409);
        } finally {
          await seed.query("UPDATE platform_invoices SET status = 'PARTIALLY_PAID' WHERE id = $1", [inv]);
        }
        clock.current = saved;
      });

      it('la base de datos solo admite la anulación: ni cambiar importes, ni deshacerla, ni anular sin motivo', async () => {
        const [confirmed] = await q<{ id: string }>(
          "SELECT id FROM subscription_payments WHERE status = 'CONFIRMED' LIMIT 1",
        );
        const [reversed] = await q<{ id: string }>(
          "SELECT id FROM subscription_payments WHERE status = 'REVERSED' LIMIT 1",
        );
        await expect(
          seed.query('UPDATE subscription_payments SET amount = 1 WHERE id = $1', [confirmed!.id]),
        ).rejects.toThrow(/solo se admite anular/);
        await expect(
          seed.query(
            `UPDATE subscription_payments SET status = 'CONFIRMED', reversed_at = NULL,
                    reversed_by_platform_user_id = NULL, reversal_reason = NULL WHERE id = $1`,
            [reversed!.id],
          ),
        ).rejects.toThrow(/solo se admite anular/);
        await expect(
          seed.query(
            "UPDATE subscription_payments SET status = 'REVERSED', reversed_at = now() WHERE id = $1",
            [confirmed!.id],
          ),
        ).rejects.toThrow(/subscription_payments_reversal/);
        await expect(
          seed.query(
            `UPDATE subscription_payments SET status = 'REVERSED', reversed_at = now(), reversal_reason = 'Rebote',
                    reversed_by_platform_user_id = recorded_by_platform_user_id, reference = 'otra' WHERE id = $1`,
            [confirmed!.id],
          ),
        ).rejects.toThrow(/solo se admite anular/);
        // Una anulación no se reescribe, y un pago confirmado no admite otra actualización que su anulación.
        await expect(
          seed.query("UPDATE subscription_payments SET reversal_reason = 'Otro motivo' WHERE id = $1", [
            reversed!.id,
          ]),
        ).rejects.toThrow(/solo se admite anular/);
        await expect(
          seed.query("UPDATE subscription_payments SET status = 'CONFIRMED' WHERE id = $1", [confirmed!.id]),
        ).rejects.toThrow(/solo se admite anular/);
        // Anular cambiando a la vez cualquier otro dato del pago: rechazado, columna a columna.
        for (const change of [
          'amount = amount + 1',
          "method = 'OTHER'",
          "paid_at = paid_at - interval '1 day'",
          "created_at = created_at - interval '1 day'",
          'invoice_id = gen_random_uuid()',
          'tenant_id = gen_random_uuid()',
          'id = gen_random_uuid()',
          'recorded_by_platform_user_id = gen_random_uuid()',
        ]) {
          await expect(
            seed.query(
              `UPDATE subscription_payments SET status = 'REVERSED', reversed_at = now(), reversal_reason = 'Rebote',
                      reversed_by_platform_user_id = recorded_by_platform_user_id, ${change} WHERE id = $1`,
              [confirmed!.id],
            ),
          ).rejects.toThrow(/solo se admite anular/);
        }
        await expect(
          seed.query('DELETE FROM subscription_payments WHERE id = $1', [reversed!.id]),
        ).rejects.toThrow();
      });
    });
  });

  describe('cambio de plan a mitad de período (decisión del 2026-11-10)', () => {
    let staff = '';
    /** Versión publicada de un plan nuevo. */
    const version = async (base: number, included: number, extra: number) => {
      const planId = uuid();
      const versionId = uuid();
      await owner.query(
        `INSERT INTO plans (id, code, name, status, updated_at) VALUES ($1, $2, 'P', 'ACTIVE', now())`,
        [planId, `plan-${seq}`],
      );
      await owner.query(
        `INSERT INTO plan_versions (id, plan_id, version, status, currency, base_price, billing_interval, included_users,
                                    extra_user_price, payment_terms_days, published_at, updated_at)
         VALUES ($1, $2, 1, 'PUBLISHED', 'PEN', $3, 'MONTHLY', $4, $5, 7, now(), now())`,
        [versionId, planId, base, included, extra],
      );
      return versionId;
    };
    const change = (tenantId: string, planVersionId: string, who = staff) =>
      request(app.getHttpServer())
        .post(`/api/v1/platform/tenants/${tenantId}/subscription/plan`)
        .set('Host', ADMIN)
        .set('Cookie', who)
        .set('X-CSRF-Token', STAFF_CSRF)
        .send({ planVersionId, reason: 'Solicitud del cliente' });
    const subs = (tenantId: string) =>
      q(
        `SELECT plan_version_id AS plan, is_current, to_char(current_period_start, 'YYYY-MM-DD') AS s,
                to_char(current_period_end, 'YYYY-MM-DD') AS e, next_plan_version_id AS next
           FROM subscriptions WHERE tenant_id = $1 ORDER BY current_period_start, is_current NULLS FIRST`,
        [tenantId],
      );

    beforeEach(async () => {
      staff = (
        await seedPlatformSession(seed, {
          email: `cambios-${uuid()}@yebo.pe`,
          role: 'BILLING',
          now: clock.now(),
        })
      ).cookie;
    });

    it('upgrade: aplica desde hoy; el período anterior se cierra prorrateado y el nuevo empieza hoy con su ciclo', async () => {
      const t = await company();
      const upgradeTo = await version(199, 10, 20);
      clock.current = new Date('2026-10-21T15:00:00Z'); // 10:00 del 21/10 en Lima
      staff = (
        await seedPlatformSession(seed, {
          email: `cambios-${uuid()}@yebo.pe`,
          role: 'BILLING',
          now: clock.now(),
        })
      ).cookie;
      const res = await change(t, upgradeTo);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ kind: 'UPGRADE', effectiveOn: '2026-10-21' });
      expect(await subs(t)).toEqual([
        expect.objectContaining({ is_current: null, s: '2026-10-01', e: '2026-11-01' }),
        { plan: upgradeTo, is_current: true, s: '2026-10-21', e: '2026-11-21', next: null },
      ]);
      // El período anterior se cierra en cuanto termina su último día (20/10): 20 de 31 días.
      expect(await close(t, '2026-10-21T16:00:00Z')).toBe(1);
      const [calc] = await q<Record<string, unknown>>(
        `SELECT metric_value, extra_users, base_amount::text, total_amount::text, jsonb_array_length(daily_series) AS days,
                pricing -> 'proration' AS proration
           FROM usage_period_calculations c JOIN billing_periods p ON p.id = c.billing_period_id
          WHERE c.tenant_id = $1 AND p.period_start = '2026-10-01'`,
        [t],
      );
      // 99 × 20/31 = 63,87 de base + 7 adicionales × 15 medidos esos días = 168,87.
      expect(calc).toEqual({
        metric_value: 12,
        extra_users: 7,
        base_amount: '63.87',
        total_amount: '168.87',
        days: 20,
        proration: { daysUsed: 20, daysTotal: 31, fullBasePrice: '99.00' },
      });
      expect(
        await q(
          `SELECT to_char(issue_date, 'YYYY-MM-DD') AS issue, to_char(due_date, 'YYYY-MM-DD') AS due, total::text
                   FROM platform_invoices WHERE tenant_id = $1`,
          [t],
        ),
      ).toEqual([{ issue: '2026-10-21', due: '2026-10-28', total: '168.87' }]);
      // El período nuevo se factura a su cierre con el plan nuevo: 5 usuarios < 10 incluidos → 199,00.
      expect(await close(t, '2026-11-21T05:16:00Z')).toBe(1);
      expect(
        await q(`SELECT total::text FROM platform_invoices WHERE tenant_id = $1 ORDER BY issue_date`, [t]),
      ).toEqual([{ total: '168.87' }, { total: '199.00' }]);
      expect((await subs(t)).at(-1)).toMatchObject({
        plan: upgradeTo,
        is_current: true,
        s: '2026-11-21',
        e: '2026-12-21',
      });
      // El corte no se puede mover una vez fijado (ni con el período cerrado).
      await expect(
        seed.query(
          "UPDATE billing_periods SET cut_off = '2026-10-25' WHERE tenant_id = $1 AND cut_off IS NOT NULL",
          [t],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('downgrade: se programa y aplica desde el período siguiente; el período en curso se cobra completo', async () => {
      const t = await company();
      const cheaper = await version(49, 3, 10);
      clock.current = new Date('2026-10-10T15:00:00Z');
      staff = (
        await seedPlatformSession(seed, {
          email: `cambios-${uuid()}@yebo.pe`,
          role: 'BILLING',
          now: clock.now(),
        })
      ).cookie;
      const res = await change(t, cheaper);
      expect(res.body).toEqual({ kind: 'DOWNGRADE', effectiveOn: '2026-11-01' });
      expect((await subs(t))[0]).toMatchObject({ is_current: true, next: cheaper });
      await close(t, '2026-11-01T05:16:00Z');
      expect(await q('SELECT total::text FROM platform_invoices WHERE tenant_id = $1', [t])).toEqual([
        { total: '204.00' },
      ]);
      expect(await subs(t)).toEqual([
        expect.objectContaining({ is_current: null, next: null, s: '2026-10-01' }),
        { plan: cheaper, is_current: true, s: '2026-11-01', e: '2026-12-01', next: null },
      ]);
      expect(
        await q(
          `SELECT to_char(period_start, 'YYYY-MM-DD') AS s, status::text FROM billing_periods WHERE tenant_id = $1 ORDER BY period_start`,
          [t],
        ),
      ).toEqual([
        { s: '2026-10-01', status: 'CLOSED' },
        { s: '2026-11-01', status: 'OPEN' },
      ]);
    });

    it('la misma versión, una no publicada, una empresa suspendida o un VIEWER → rechazado', async () => {
      const t = await company();
      const current =
        (
          await q<{ plan: string }>(
            'SELECT plan_version_id AS plan FROM subscriptions WHERE tenant_id = $1',
            [t],
          )
        )[0]?.plan ?? '';
      clock.current = new Date('2026-10-10T15:00:00Z');
      staff = (
        await seedPlatformSession(seed, {
          email: `cambios-${uuid()}@yebo.pe`,
          role: 'BILLING',
          now: clock.now(),
        })
      ).cookie;
      const viewer = (
        await seedPlatformSession(seed, { email: `ver-${uuid()}@yebo.pe`, role: 'VIEWER', now: clock.now() })
      ).cookie;
      expect((await change(t, current)).status).toBe(409);
      const draft = uuid();
      await owner.query(
        `INSERT INTO plan_versions (id, plan_id, version, status, currency, base_price, billing_interval, included_users,
                                    extra_user_price, updated_at)
         SELECT $1, plan_id, 2, 'DRAFT', 'PEN', 500, 'MONTHLY', 50, 50, now() FROM plan_versions WHERE id = $2`,
        [draft, current],
      );
      expect((await change(t, draft)).status).toBe(409);
      expect((await change(t, await version(300, 20, 30), viewer)).status).toBe(403);
      await owner.query("UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1", [t]);
      expect((await change(t, await version(300, 20, 30))).status).toBe(409);
    });
  });
});
