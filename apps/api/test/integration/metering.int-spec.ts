/**
 * Fase 4.4 · Medición de usuarios (billing §1–4 y §8): historial escrito por triggers en la misma transacción,
 * inmodificable hacia atrás; valor diario (pico simultáneo y distintos) en la zona horaria de la empresa; snapshots
 * FINAL idempotentes con el rol yebo_metering y el contexto de cada tenant. PostgreSQL y Redis reales.
 *
 * Los historiales del pasado se siembran como propietario con los triggers desactivados DENTRO de la transacción de
 * la siembra (el DDL es transaccional: ninguna otra sesión los ve desactivados). El resto usa los triggers reales.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { Clock } from '../../src/modules/identity/clock';
import { MeteringPrismaService } from '../../src/modules/metering/metering-prisma.service';
import { MeteringService } from '../../src/modules/metering/metering.service';
import { USAGE_METERING_QUEUE } from '../../src/modules/metering/metering.worker';
import { computeUsageDay } from '../../src/modules/metering/usage-calculation';
import { WorkerModule } from '../../src/worker.module';
import { testBypassPool, testPool } from '../support/db';
import { seedPlatformSession } from '../support/platform-session';

const DB = 'yebo_test';
const HOUR = 3_600_000;
/** Membresía ficticia que actúa como autora de un cambio (el historial no exige que exista). */
const ACTOR = '0190f0a0-0000-7000-8000-00000000ac70';

class FakeClock extends Clock {
  constructor(public current: Date) {
    super();
  }
  now(): Date {
    return this.current;
  }
}

let seq = 0;
const uuid = () => `0190f0a0-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

describe('Fase 4.4 · medición de usuarios', () => {
  let owner: Pool;
  let seed: Pool;
  let metering: MeteringPrismaService;

  const newTenant = async (timezone = 'America/Lima'): Promise<string> => {
    const id = uuid();
    await owner.query(
      `INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id_type, tax_id, status, timezone, updated_at)
       VALUES ($1, $2, 'X', 'X', 'RUC', $3, 'ACTIVE', $4, now())`,
      [id, `medicion-${seq}`, `20${String(seq).padStart(9, '0')}`, timezone],
    );
    return id;
  };

  /** Siembra como propietario, con los triggers desactivados solo dentro de esta transacción. */
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
  /** Persona con membresía en la empresa (sin historial: lo pone `interval`). */
  const person = async (c: PoolClient, tenantId: string, name: string) => {
    const userId = uuid();
    const membershipId = uuid();
    await c.query(
      `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
       VALUES ($1, $2, 'x', $3, 'ACTIVE', now())`,
      [userId, `${name}-${seq}@medicion.pe`, name],
    );
    await c.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at) VALUES ($1, $2, $3, 'ACTIVE', now())`,
      [membershipId, tenantId, userId],
    );
    return { userId, membershipId };
  };
  /** Intervalo del historial; `billable = false` lo siembra como membresía suspendida (no facturable). */
  const interval = async (
    c: PoolClient,
    tenantId: string,
    p: { userId: string; membershipId: string },
    from: string,
    to: string | null,
    billable = true,
  ) => {
    await c.query(
      `INSERT INTO membership_status_history (tenant_id, membership_id, user_id, status, billable, user_active,
                                              effective_billable, valid_from, valid_to, changed_by_kind)
       VALUES ($1, $2, $3, $4, true, true, $5, $6, $7, 'SYSTEM')`,
      [tenantId, p.membershipId, p.userId, billable ? 'ACTIVE' : 'SUSPENDED', billable, from, to],
    );
  };
  /** Valor de un día con yebo_metering y el contexto del tenant. */
  const day = (tenantId: string, date: string, timezone = 'America/Lima', minActiveSeconds = 0) =>
    metering.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return computeUsageDay(tx, { tenantId, date, timezone, minActiveSeconds });
    });
  const snapshots = async (tenantId: string) =>
    (
      await seed.query<{ d: string; peak: number; distinct: number; n: number }>(
        `SELECT to_char(usage_date, 'YYYY-MM-DD') AS d, peak_concurrent AS peak, distinct_active AS distinct,
                jsonb_array_length(detail -> 'intervals') AS n
           FROM usage_daily_snapshots WHERE tenant_id = $1 ORDER BY usage_date`,
        [tenantId],
      )
    ).rows.map(({ d, peak, distinct, n }) => ({ d, peak, distinct, n }));

  beforeAll(async () => {
    owner = testPool('owner', DB, 3);
    seed = testBypassPool(DB, 3);
    await owner.query(
      `TRUNCATE usage_daily_snapshots, membership_status_history, membership_invitations, plan_version_modules,
                subscriptions, tenant_module_overrides, plan_versions, plans, tenant_settings, tenant_services,
                tenant_status_history, tenant_operation_overrides, platform_audit_logs, platform_setup_tokens,
                platform_sessions, platform_users, authorization_codes, refresh_tokens, tenant_sessions,
                identity_sessions, membership_roles, role_permissions, roles, tenant_memberships, users,
                tenant_domains, tenants CASCADE`,
    );
    metering = new MeteringPrismaService(parseEnv({ ...process.env, PG_DATABASE: DB }));
  });

  afterAll(async () => {
    await metering.onModuleDestroy();
    await Promise.all([owner.end(), seed.end()]);
  });

  describe('valor diario (billing §3)', () => {
    it('el ejemplo de §3.1 da peak_concurrent = 3 y distinct_active = 4', async () => {
      const t = await newTenant();
      await fixture(t, async (c) => {
        const [ana, beto, carla, dino] = await Promise.all(
          ['ana', 'beto', 'carla', 'dino'].map((n) => person(c, t, n)),
        );
        // Lima = UTC−5: el 10/11 local es [10/11 05:00Z, 11/11 05:00Z).
        await interval(c, t, ana!, '2026-11-01T05:00Z', null);
        await interval(c, t, beto!, '2026-11-01T05:00Z', '2026-11-10T15:00Z'); // hasta las 10:00
        await interval(c, t, beto!, '2026-11-10T15:00Z', null, false); // suspendido
        await interval(c, t, carla!, '2026-11-10T15:00Z', null); // desde las 10:00
        await interval(c, t, dino!, '2026-11-10T19:00Z', '2026-11-10T21:00Z'); // 14:00–16:00
      });
      const d = await day(t, '2026-11-10');
      expect(d).toMatchObject({
        peakConcurrent: 3,
        distinctActive: 4,
        dayFrom: new Date('2026-11-10T05:00Z'),
        dayTo: new Date('2026-11-11T05:00Z'),
      });
      expect(d.intervals).toHaveLength(4);
      // El detalle de auditoría guarda los intervalos recortados al día.
      for (const i of d.intervals) {
        expect(new Date(i.from).getTime()).toBeGreaterThanOrEqual(d.dayFrom.getTime());
        expect(new Date(i.to).getTime()).toBeLessThanOrEqual(d.dayTo.getTime());
      }
    });

    it('una membresía con dos tramos facturables en el día cuenta una vez en distinct_active', async () => {
      const t = await newTenant();
      await fixture(t, async (c) => {
        const zoe = await person(c, t, 'zoe');
        await interval(c, t, zoe, '2026-11-10T13:00Z', '2026-11-10T14:00Z');
        await interval(c, t, zoe, '2026-11-10T14:00Z', '2026-11-10T16:00Z', false);
        await interval(c, t, zoe, '2026-11-10T16:00Z', null);
      });
      const d = await day(t, '2026-11-10');
      expect(d).toMatchObject({ peakConcurrent: 1, distinctActive: 1 });
      expect(d.intervals).toHaveLength(2);
    });

    it('reemplazo en el mismo instante: no hay doble conteo', async () => {
      const t = await newTenant();
      await fixture(t, async (c) => {
        const [eva, ana, luis] = await Promise.all(['eva', 'ana', 'luis'].map((n) => person(c, t, n)));
        await interval(c, t, eva!, '2026-11-01T05:00Z', null);
        await interval(c, t, ana!, '2026-11-01T05:00Z', '2026-11-10T17:00Z');
        await interval(c, t, luis!, '2026-11-10T17:00Z', null);
      });
      expect(await day(t, '2026-11-10')).toMatchObject({ peakConcurrent: 2, distinctActive: 3 });
    });

    it('días con cambio de hora: 23 y 25 horas, y la última hora cuenta', async () => {
      const t = await newTenant('Europe/Madrid');
      await fixture(t, async (c) => {
        const [x, y, z] = await Promise.all(['x', 'y', 'z'].map((n) => person(c, t, n)));
        await interval(c, t, x!, '2026-03-01T00:00Z', null);
        // 29/03: 23:00–24:00 locales (UTC+2 tras el cambio) = 21:00–22:00Z.
        await interval(c, t, y!, '2026-03-29T21:00Z', '2026-03-29T22:00Z');
        // 25/10: la hora repetida 02:00–03:00 (UTC+1) = 01:00–02:00Z, solo existe ese día.
        await interval(c, t, z!, '2026-10-25T01:00Z', '2026-10-25T02:00Z');
      });
      const spring = await day(t, '2026-03-29', 'Europe/Madrid');
      expect(spring.dayTo.getTime() - spring.dayFrom.getTime()).toBe(23 * HOUR);
      expect(spring).toMatchObject({ peakConcurrent: 2, distinctActive: 2 });
      const autumn = await day(t, '2026-10-25', 'Europe/Madrid');
      expect(autumn.dayTo.getTime() - autumn.dayFrom.getTime()).toBe(25 * HOUR);
      expect(autumn).toMatchObject({ peakConcurrent: 2, distinctActive: 2 });
      expect(await day(t, '2026-10-26', 'Europe/Madrid')).toMatchObject({
        peakConcurrent: 1,
        distinctActive: 1,
      });
    });

    it('no cuentan: suspendidos, no facturables, usuarios deshabilitados ni el staff de YEBO', async () => {
      await seedPlatformSession(seed, { email: 'staff@yebo.pe', role: 'SUPERADMIN', now: new Date() });
      const t = await newTenant();
      await fixture(t, async (c) => {
        const [a, b, d] = await Promise.all(['a', 'b', 'd'].map((n) => person(c, t, n)));
        await interval(c, t, a!, '2026-11-01T05:00Z', null);
        await interval(c, t, b!, '2026-11-01T05:00Z', null, false);
        await c.query(
          `INSERT INTO membership_status_history (tenant_id, membership_id, user_id, status, billable, user_active,
                                                  effective_billable, valid_from, changed_by_kind)
           VALUES ($1, $2, $3, 'ACTIVE', true, false, false, '2026-11-01T05:00Z', 'SYSTEM')`,
          [t, d!.membershipId, d!.userId],
        );
      });
      const d = await day(t, '2026-11-10');
      expect(d).toMatchObject({ peakConcurrent: 1, distinctActive: 1 });
      // El staff no tiene membresías: el detalle solo contiene membresías de la empresa.
      const staffIds = (await seed.query<{ id: string }>('SELECT id FROM platform_users')).rows.map(
        (r) => r.id,
      );
      expect(d.intervals.some((i) => staffIds.includes(i.membershipId))).toBe(false);
    });

    it('min_active_seconds del plan ignora los intervalos más cortos', async () => {
      const t = await newTenant();
      await fixture(t, async (c) => {
        const [a, b] = await Promise.all(['a', 'b'].map((n) => person(c, t, n)));
        await interval(c, t, a!, '2026-11-01T05:00Z', null);
        await interval(c, t, b!, '2026-11-10T15:00Z', '2026-11-10T15:01Z'); // 60 s
      });
      expect(await day(t, '2026-11-10', 'America/Lima', 0)).toMatchObject({ peakConcurrent: 2 });
      expect(await day(t, '2026-11-10', 'America/Lima', 300)).toMatchObject({
        peakConcurrent: 1,
        distinctActive: 1,
      });
    });

    it('RLS: sin contexto, yebo_metering no ve historial; con el de otra empresa, tampoco el ajeno', async () => {
      const t = await newTenant();
      await fixture(t, async (c) => interval(c, t, await person(c, t, 'solo'), '2026-11-01T05:00Z', null));
      const other = await newTenant();
      const count = (ctx: string | null) =>
        metering.client.$transaction(async (tx) => {
          if (ctx) await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx}, true)`;
          const rows = await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM membership_status_history WHERE tenant_id = ${t}::uuid`;
          return rows[0]?.n;
        });
      expect(await count(null)).toBe(0);
      expect(await count(other)).toBe(0);
      expect(await count(t)).toBe(1);
    });
  });

  describe('snapshots diarios (billing §4)', () => {
    const build = async (t: string) =>
      fixture(t, async (c) => {
        const [a, b, d] = await Promise.all(['a', 'b', 'd'].map((n) => person(c, t, n)));
        await interval(c, t, a!, '2026-11-01T05:00Z', null);
        await interval(c, t, b!, '2026-11-02T15:00Z', '2026-11-03T15:00Z');
        await interval(c, t, d!, '2026-11-03T20:00Z', null);
      });

    it('job caído 3 días: el resultado coincide con el que habría dado a tiempo, y repetir no cambia nada', async () => {
      const onTime = await newTenant();
      const late = await newTenant();
      await build(onTime);
      await build(late);
      const job = (at: string) => new MeteringService(metering, new FakeClock(new Date(at)));
      // A tiempo: cada día, 16 min después de la medianoche de Lima.
      for (const at of ['2026-11-02T05:16Z', '2026-11-03T05:16Z', '2026-11-04T05:16Z']) {
        await job(at).closeDays(onTime, 'America/Lima', new Date(at));
      }
      // Tarde: una sola ejecución tres días después.
      expect(
        await job('2026-11-04T05:16Z').closeDays(late, 'America/Lima', new Date('2026-11-04T05:16Z')),
      ).toBe(3);
      const expected = [
        { d: '2026-11-01', peak: 1, distinct: 1, n: 1 },
        { d: '2026-11-02', peak: 2, distinct: 2, n: 2 },
        { d: '2026-11-03', peak: 2, distinct: 3, n: 3 },
      ];
      expect(await snapshots(onTime)).toEqual(expected);
      expect(await snapshots(late)).toEqual(expected);
      // Antes de los 15 min de margen, el día siguiente aún no se cierra; repetir no crea nada.
      expect(
        await job('2026-11-05T05:14Z').closeDays(late, 'America/Lima', new Date('2026-11-05T05:14Z')),
      ).toBe(0);
      expect(
        await job('2026-11-05T05:16Z').closeDays(late, 'America/Lima', new Date('2026-11-05T05:16Z')),
      ).toBe(1);
    });

    it('dos ejecuciones simultáneas no duplican ni fallan', async () => {
      const t = await newTenant();
      await build(t);
      const at = new Date('2026-11-04T05:16Z');
      const svc = new MeteringService(metering, new FakeClock(at));
      const results = await Promise.all([
        svc.closeDays(t, 'America/Lima', at),
        svc.closeDays(t, 'America/Lima', at),
      ]);
      expect(results.reduce((a, b) => a + b, 0)).toBe(3);
      expect(await snapshots(t)).toHaveLength(3);
    });

    it('un snapshot es definitivo: UPDATE y DELETE rechazados aunque se salte el RLS', async () => {
      await expect(seed.query('UPDATE usage_daily_snapshots SET peak_concurrent = 99')).rejects.toMatchObject(
        {
          code: 'P0001',
        },
      );
      await expect(seed.query('DELETE FROM usage_daily_snapshots')).rejects.toMatchObject({ code: 'P0001' });
      const app = testPool('app', DB, 1);
      try {
        await expect(app.query('DELETE FROM usage_daily_snapshots')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await app.end();
      }
    });

    it('el worker registra un único planificador horario de medición', async () => {
      const ref = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
      const worker = ref.createNestApplication({ bufferLogs: true });
      await worker.init();
      try {
        const queue = worker.get<Queue>(getQueueToken(USAGE_METERING_QUEUE));
        const schedulers = await queue.getJobSchedulers();
        expect(schedulers.filter((s) => s.key === 'usage-metering-run-due')).toHaveLength(1);
      } finally {
        await worker.close();
      }
    });
  });

  describe('historial escrito por triggers (billing §2.1)', () => {
    let t = '';
    let other = '';
    let userId = '';
    let membershipId = '';
    const history = async (m: string) =>
      (
        await seed.query<{
          status: string;
          effective: boolean;
          user_active: boolean;
          from: Date;
          to: Date | null;
        }>(
          `SELECT status::text, effective_billable AS effective, user_active, valid_from AS "from", valid_to AS "to"
             FROM membership_status_history WHERE membership_id = $1 ORDER BY valid_from, valid_to NULLS LAST`,
          [m],
        )
      ).rows;

    beforeAll(async () => {
      t = await newTenant();
      other = await newTenant();
      userId = uuid();
      membershipId = uuid();
      await seed.query(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES ($1, 'vivo@medicion.pe', 'x', 'Vivo', 'ACTIVE', now())`,
        [userId],
      );
      await seed.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at) VALUES
           ($1, $2, $3, 'ACTIVE', now()), (gen_random_uuid(), $4, $3, 'ACTIVE', now())`,
        [membershipId, t, userId, other],
      );
    });

    it('un alta abre su fila vigente, facturable', async () => {
      const rows = await history(membershipId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'ACTIVE', effective: true, user_active: true, to: null });
    });

    it('yebo_app (sin acceso a users) suspende: cierra la vigente y abre otra en el mismo instante', async () => {
      const app = testPool('app', DB, 1);
      const c = await app.connect();
      try {
        // Sin declarar el autor, la base rechaza el cambio.
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [t]);
        await expect(
          c.query("UPDATE tenant_memberships SET status = 'SUSPENDED' WHERE id = $1", [membershipId]),
        ).rejects.toMatchObject({ code: 'P0001' });
        await c.query('ROLLBACK');
        // Un autor de empresa sin id, tampoco.
        await c.query('BEGIN');
        await c.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_kind', 'MEMBERSHIP', true)",
          [t],
        );
        await expect(
          c.query("UPDATE tenant_memberships SET status = 'SUSPENDED' WHERE id = $1", [membershipId]),
        ).rejects.toMatchObject({ code: 'P0001' });
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await c.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_kind', 'MEMBERSHIP', true),
                  set_config('app.actor_id', $2, true), set_config('app.change_reason', 'members.suspend', true)`,
          [t, ACTOR],
        );
        await c.query("UPDATE tenant_memberships SET status = 'SUSPENDED' WHERE id = $1", [membershipId]);
        await c.query('COMMIT');
      } finally {
        c.release();
        await app.end();
      }
      const rows = await history(membershipId);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.to?.getTime()).toBe(rows[1]?.from.getTime());
      expect(rows[1]).toMatchObject({ status: 'SUSPENDED', effective: false, user_active: true, to: null });
      const actor = await seed.query(
        `SELECT changed_by_kind::text AS kind, changed_by_id AS id, reason FROM membership_status_history
          WHERE membership_id = $1 ORDER BY valid_from, valid_to NULLS LAST`,
        [membershipId],
      );
      // La fila del alta (rol de pruebas) es SYSTEM; la de la suspensión lleva su autor.
      expect(actor.rows).toEqual([
        { kind: 'SYSTEM', id: null, reason: null },
        { kind: 'MEMBERSHIP', id: ACTOR, reason: 'members.suspend' },
      ]);
    });

    it('si el cambio se deshace, el historial también (misma transacción)', async () => {
      const c = await seed.connect();
      try {
        await c.query('BEGIN');
        await c.query("UPDATE tenant_memberships SET status = 'ACTIVE' WHERE id = $1", [membershipId]);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
      expect(await history(membershipId)).toHaveLength(2);
    });

    it('dos cambios en una transacción: la fila intermedia dura 0 y no solapa', async () => {
      const c = await seed.connect();
      try {
        await c.query('BEGIN');
        await c.query("UPDATE tenant_memberships SET status = 'ACTIVE' WHERE id = $1", [membershipId]);
        await c.query('UPDATE tenant_memberships SET billable = false WHERE id = $1', [membershipId]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      const rows = await history(membershipId);
      expect(rows).toHaveLength(4);
      expect(rows[2]?.from.getTime()).toBe(rows[2]?.to?.getTime());
      expect(rows[3]).toMatchObject({ status: 'ACTIVE', effective: false, to: null }); // no facturable
    });

    it('un UPDATE que no cambia estado ni billable no añade filas', async () => {
      const before = (await history(membershipId)).length;
      await seed.query('UPDATE tenant_memberships SET status = status, billable = billable WHERE id = $1', [
        membershipId,
      ]);
      expect(await history(membershipId)).toHaveLength(before);
    });

    it('deshabilitar al usuario cierra y reabre en TODAS sus empresas y restaura el contexto', async () => {
      const unrelated = await newTenant(); // contexto ajeno a las dos empresas del usuario
      const c = await seed.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [unrelated]);
        await c.query("UPDATE users SET status = 'DISABLED' WHERE id = $1", [userId]);
        const ctx = await c.query<{ v: string }>("SELECT current_setting('app.tenant_id', true) AS v");
        expect(ctx.rows[0]?.v).toBe(unrelated);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      const open = await seed.query<{ tenant_id: string; user_active: boolean; effective: boolean }>(
        `SELECT tenant_id, user_active, effective_billable AS effective FROM membership_status_history
          WHERE user_id = $1 AND valid_to IS NULL ORDER BY tenant_id`,
        [userId],
      );
      expect(open.rows).toEqual(
        [t, other].sort().map((id) => ({ tenant_id: id, user_active: false, effective: false })),
      );
    });

    it('el alta de un usuario ya deshabilitado abre su fila como no facturable', async () => {
      const t2 = await newTenant();
      const m = uuid();
      await seed.query(
        'INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at) VALUES ($1, $2, $3, $4, now())',
        [m, t2, userId, 'ACTIVE'],
      );
      expect(await history(m)).toEqual([
        expect.objectContaining({ status: 'ACTIVE', user_active: false, effective: false }),
      ]);
    });

    it('el historial no se reescribe: sin DELETE, sin fechas retroactivas, solo se cierra la vigente', async () => {
      for (const [sql, params] of [
        ['DELETE FROM membership_status_history WHERE membership_id = $1', [membershipId]],
        [
          "UPDATE membership_status_history SET valid_from = valid_from - interval '1 day' WHERE membership_id = $1",
          [membershipId],
        ],
        [
          'UPDATE membership_status_history SET valid_to = now() WHERE membership_id = $1 AND valid_to IS NOT NULL',
          [membershipId],
        ],
        [
          'UPDATE membership_status_history SET billable = true WHERE membership_id = $1 AND valid_to IS NULL',
          [membershipId],
        ],
        [
          `INSERT INTO membership_status_history (tenant_id, membership_id, user_id, status, billable, user_active,
                                                  effective_billable, valid_from, changed_by_kind)
           VALUES ($1, $2, $3, 'ACTIVE', true, true, true, now() - interval '1 hour', 'SYSTEM')`,
          [t, membershipId, userId],
        ],
      ] as const) {
        await expect(seed.query(sql, [...params])).rejects.toMatchObject({ code: 'P0001' });
      }
      // effective_billable incoherente: el CHECK lo rechaza.
      await expect(
        seed.query(
          `INSERT INTO membership_status_history (tenant_id, membership_id, user_id, status, billable, user_active,
                                                  effective_billable, valid_from, changed_by_kind)
           VALUES ($1, $2, $3, 'SUSPENDED', true, true, true, now(), 'SYSTEM')`,
          [t, uuid(), userId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('panel: consumo diario', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const ref = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(Clock)
        .useValue(new FakeClock(new Date()))
        .compile();
      const nest = ref.createNestApplication<NestExpressApplication>({ bufferLogs: true });
      configureApp(nest, parseEnv(process.env), { swagger: false });
      await nest.init();
      app = nest;
    });

    afterAll(async () => {
      await app.close();
    });

    it('días FINAL y el día en curso PROVISIONAL; VIEWER lo ve; rango inválido → 400', async () => {
      const t = await newTenant();
      await fixture(t, async (c) => interval(c, t, await person(c, t, 'hoy'), '2026-11-01T05:00Z', null));
      await new MeteringService(metering, new FakeClock(new Date('2026-11-03T05:16Z'))).closeDays(
        t,
        'America/Lima',
        new Date('2026-11-03T05:16Z'),
      );
      const staff = await seedPlatformSession(seed, {
        email: 'visor@yebo.pe',
        role: 'VIEWER',
        now: new Date(),
      });
      const today = (
        await owner.query<{ d: string }>(
          "SELECT to_char((now() AT TIME ZONE 'America/Lima')::date, 'YYYY-MM-DD') AS d",
        )
      ).rows[0]?.d as string;
      const res = await request(app.getHttpServer())
        .get(`/api/v1/platform/tenants/${t}/usage?from=2026-11-01&to=${today}`)
        .set('Host', 'admin.yebo.pe')
        .set('Cookie', staff.cookie);
      expect(res.status).toBe(200);
      expect(res.body.timezone).toBe('America/Lima');
      expect(res.body.days.slice(0, 2)).toEqual([
        { date: '2026-11-01', peakConcurrent: 1, distinctActive: 1, status: 'FINAL' },
        { date: '2026-11-02', peakConcurrent: 1, distinctActive: 1, status: 'FINAL' },
      ]);
      expect(res.body.days.at(-1)).toEqual({
        date: today,
        peakConcurrent: 1,
        distinctActive: 1,
        status: 'PROVISIONAL',
      });
      const bad = await request(app.getHttpServer())
        .get(`/api/v1/platform/tenants/${t}/usage?from=2026-11-05&to=2026-11-01`)
        .set('Host', 'admin.yebo.pe')
        .set('Cookie', staff.cookie);
      expect(bad.status).toBe(400);
    });
  });
});
