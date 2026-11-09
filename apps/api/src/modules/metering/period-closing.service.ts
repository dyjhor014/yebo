import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { periodAmounts, periodValue, prorate, resolvePricing } from '../billing/pricing';
import { Clock } from '../identity/clock';
import { MeteringPrismaService } from './metering-prisma.service';
import { DAY_CLOSE_MARGIN_MINUTES, insertSnapshot } from './metering.service';
import { minActiveSecondsOf } from './usage-calculation';

type Tx = Prisma.TransactionClient;
const INTERVAL_MONTHS = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 } as const;

interface PeriodRow {
  id: string;
  subscription_id: string;
  period_start: string;
  period_end: string;
  /** Upgrade a mitad de período: fin real (exclusivo) del período. */
  cut_off: string | null;
  /** `cut_off` o, si no hay, `period_end`. */
  effective_end: string;
  timezone: string;
  is_trial: boolean;
  status: 'OPEN' | 'CLOSING' | 'CLOSED';
}

/**
 * Cierre de períodos (billing §6; Fase 4.5), por empresa y con su contexto (RLS), en UNA transacción por empresa:
 *  1. abre el período de la suscripción vigente si aún no existe (zona horaria de la empresa, FIJA desde entonces);
 *  2. para cada período cuyo último día terminó hace 15 min en su zona: OPEN → CLOSING; completa los snapshots que
 *     falten (nunca se factura con días faltantes); calcula el valor y el importe con la copia de la versión de plan
 *     y el precio resuelto (F4-Q1); si el período no es de prueba, emite la factura con sus líneas; CLOSED;
 *  3. avanza la suscripción y abre el período siguiente (salvo empresas CANCELLED o EXPIRED).
 * Idempotente: los cálculos y facturas son únicos por período, y un período cerrado ya no se procesa.
 */
@Injectable()
export class PeriodClosingService {
  private readonly logger = new Logger(PeriodClosingService.name);

  constructor(
    private readonly db: MeteringPrismaService,
    private readonly clock: Clock,
  ) {}

  /** Devuelve cuántos períodos cerró. */
  async runDue(): Promise<number> {
    const now = this.clock.now();
    const tenants = await this.db.client.tenant.findMany({ select: { id: true } });
    let closed = 0;
    for (const t of tenants) {
      try {
        closed += await this.closeTenant(t.id, now);
      } catch (error) {
        this.logger.error({ err: error, tenantId: t.id }, 'No se pudo cerrar el período; se reintentará');
      }
    }
    return closed;
  }

  async closeTenant(tenantId: string, now: Date): Promise<number> {
    return this.db.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        // Serializa los cierres de la misma empresa (dos réplicas del worker).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('billing-close:' || ${tenantId}, 0))`;
        await this.ensureOpenPeriod(tx, tenantId);
        let closed = 0;
        // Un job caído varios períodos los cierra todos, en orden.
        for (let guard = 0; guard < 48; guard += 1) {
          const due = await this.duePeriod(tx, now);
          if (!due) break;
          await this.closePeriod(tx, tenantId, due, now);
          closed += 1;
          await this.ensureOpenPeriod(tx, tenantId);
        }
        return closed;
      },
      { timeout: 120_000 },
    );
  }

  /** Período de la suscripción vigente para su `current_period_start` (lo crea si falta). */
  private async ensureOpenPeriod(tx: Tx, tenantId: string): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO billing_periods (tenant_id, subscription_id, period_start, period_end, timezone, is_trial)
      SELECT s.tenant_id, s.id, s.current_period_start, s.current_period_end, t.timezone, s.status = 'TRIALING'
        FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
       WHERE s.is_current AND s.tenant_id = ${tenantId}::uuid AND t.status NOT IN ('CANCELLED', 'EXPIRED')
      ON CONFLICT (subscription_id, period_start) DO NOTHING`;
  }

  /** El período abierto más antiguo cuyo último día ya cerró (fin local + margen ≤ ahora). */
  private async duePeriod(tx: Tx, now: Date): Promise<PeriodRow | null> {
    const [row] = await tx.$queryRaw<PeriodRow[]>`
      SELECT id, subscription_id, to_char(period_start, 'YYYY-MM-DD') AS period_start,
             to_char(period_end, 'YYYY-MM-DD') AS period_end, to_char(cut_off, 'YYYY-MM-DD') AS cut_off,
             to_char(COALESCE(cut_off, period_end), 'YYYY-MM-DD') AS effective_end,
             timezone, is_trial, status::text AS status
        FROM billing_periods
       WHERE status <> 'CLOSED'
         AND (COALESCE(cut_off, period_end)::timestamp AT TIME ZONE timezone)
             + make_interval(mins => ${DAY_CLOSE_MARGIN_MINUTES}::int) <= ${now}::timestamptz
       ORDER BY period_start LIMIT 1 FOR UPDATE`;
    return row ?? null;
  }

  private async closePeriod(tx: Tx, tenantId: string, period: PeriodRow, now: Date): Promise<void> {
    if (period.status === 'OPEN') {
      await tx.$executeRaw`UPDATE billing_periods SET status = 'CLOSING' WHERE id = ${period.id}::uuid`;
    }
    // Versión de plan y precio vigentes de la suscripción del período.
    const [sub] = await tx.$queryRaw<
      {
        plan_version_id: string;
        price_override: unknown;
        snapshot: Record<string, unknown>;
        usage_metric: 'PEAK_DAILY' | 'AVERAGE_DAILY' | 'END_OF_PERIOD';
        daily_aggregation: 'PEAK_CONCURRENT' | 'DISTINCT_ACTIVE';
        currency: string;
        base_price: Prisma.Decimal;
        included_users: number;
        extra_user_price: Prisma.Decimal;
        tax_rate: Prisma.Decimal;
        payment_terms_days: number;
        billing_interval: keyof typeof INTERVAL_MONTHS;
        status: string;
        is_current: boolean;
        next_plan_version_id: string | null;
        next_interval: keyof typeof INTERVAL_MONTHS | null;
      }[]
    >`
      SELECT s.plan_version_id, s.price_override, to_jsonb(pv) AS snapshot, pv.usage_metric::text AS usage_metric,
             pv.daily_aggregation::text AS daily_aggregation, pv.currency, pv.base_price, pv.included_users,
             pv.extra_user_price, pv.tax_rate, pv.payment_terms_days, pv.billing_interval::text AS billing_interval,
             s.status::text AS status, COALESCE(s.is_current, false) AS is_current, s.next_plan_version_id,
             npv.billing_interval::text AS next_interval
        FROM subscriptions s JOIN plan_versions pv ON pv.id = s.plan_version_id
        LEFT JOIN plan_versions npv ON npv.id = s.next_plan_version_id
       WHERE s.id = ${period.subscription_id}::uuid`;
    if (!sub) throw new Error('El período no tiene suscripción');

    // Todos los días del período con snapshot FINAL (se calculan los que falten).
    const minActiveSeconds = await minActiveSecondsOf(tx);
    const days = await tx.$queryRaw<{ d: string }[]>`
      SELECT to_char(g.d, 'YYYY-MM-DD') AS d
        FROM generate_series(${period.period_start}::date, ${period.effective_end}::date - 1, interval '1 day') AS g(d)
       ORDER BY g.d`;
    if (days.length === 0) {
      // Upgrade el mismo día en que empezaba el período: no hubo días con el plan anterior; nada que calcular.
      await tx.$executeRaw`UPDATE billing_periods SET status = 'CLOSED', closed_at = ${now} WHERE id = ${period.id}::uuid`;
      return;
    }
    for (const { d } of days) {
      await insertSnapshot(tx, { tenantId, date: d, timezone: period.timezone, minActiveSeconds, now });
    }
    const snapshots = await tx.$queryRaw<{ d: string; peak: number; distinct_active: number }[]>`
      SELECT to_char(usage_date, 'YYYY-MM-DD') AS d, peak_concurrent AS peak, distinct_active
        FROM usage_daily_snapshots
       WHERE usage_date >= ${period.period_start}::date AND usage_date < ${period.effective_end}::date
       ORDER BY usage_date`;
    if (snapshots.length !== days.length) {
      throw new Error(`Faltan días en el período ${period.id}: ${snapshots.length} de ${days.length}`);
    }
    const series = snapshots.map((s) =>
      sub.daily_aggregation === 'PEAK_CONCURRENT' ? s.peak : s.distinct_active,
    );
    const value = periodValue(series, sub.usage_metric);
    const fullPricing = resolvePricing(
      {
        currency: sub.currency,
        basePrice: new Prisma.Decimal(sub.base_price),
        includedUsers: sub.included_users,
        extraUserPrice: new Prisma.Decimal(sub.extra_user_price),
        taxRate: new Prisma.Decimal(sub.tax_rate),
      },
      sub.price_override,
    );
    const daysTotal = (Date.parse(period.period_end) - Date.parse(period.period_start)) / 86_400_000;
    const pricing = period.cut_off ? prorate(fullPricing, days.length, daysTotal) : fullPricing;
    const amounts = periodAmounts(value, pricing);

    await tx.usagePeriodCalculation.create({
      data: {
        tenantId,
        billingPeriodId: period.id,
        usageMetric: sub.usage_metric,
        dailyAggregation: sub.daily_aggregation,
        metricValue: value,
        includedUsers: pricing.includedUsers,
        extraUsers: amounts.extraUsers,
        currency: pricing.currency,
        baseAmount: amounts.baseAmount,
        extraUserPrice: pricing.extraUserPrice,
        extraAmount: amounts.extraAmount,
        subtotal: amounts.subtotal,
        taxRate: pricing.taxRate,
        taxAmount: amounts.taxAmount,
        totalAmount: amounts.total,
        planVersionSnapshot: sub.snapshot as Prisma.InputJsonObject,
        pricing: {
          source: pricing.source,
          overrideReason: pricing.overrideReason,
          basePrice: pricing.basePrice.toFixed(2),
          extraUserPrice: pricing.extraUserPrice.toFixed(2),
          includedUsers: pricing.includedUsers,
          taxRate: pricing.taxRate.toString(),
          proration: period.cut_off
            ? { daysUsed: days.length, daysTotal, fullBasePrice: fullPricing.basePrice.toFixed(2) }
            : null,
        },
        dailySeries: snapshots.map((s) => ({ date: s.d, peak: s.peak, distinct: s.distinct_active })),
        computedAt: now,
      },
      select: { id: true },
    });

    // Los períodos de prueba se miden y calculan, pero no se facturan (decisión del 2026-11-10).
    if (!period.is_trial) {
      const id = randomUUID();
      const code = `YB-${period.effective_end.slice(0, 7).replace('-', '')}-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      const settled = amounts.total.isZero();
      await tx.$executeRaw`
        INSERT INTO platform_invoices (id, tenant_id, code, billing_period_id, status, issue_date, due_date, currency,
                                       subtotal, tax, total, balance)
        VALUES (${id}::uuid, ${tenantId}::uuid, ${code}, ${period.id}::uuid,
                ${settled ? 'PAID' : 'ISSUED'}::invoice_status, ${period.effective_end}::date,
                ${period.effective_end}::date + ${sub.payment_terms_days}::int, ${pricing.currency},
                ${amounts.subtotal}, ${amounts.taxAmount}, ${amounts.total},
                ${settled ? new Prisma.Decimal(0) : amounts.total})`;
      const lines = [
        {
          kind: 'BASE' as const,
          description: period.cut_off
            ? `Plan ${period.period_start} – ${period.cut_off} (prorrateo ${days.length}/${daysTotal} días por cambio de plan)`
            : `Plan ${period.period_start} – ${period.period_end}`,
          quantity: 1,
          unitPrice: amounts.baseAmount,
          amount: amounts.baseAmount,
        },
        ...(amounts.extraUsers > 0
          ? [
              {
                kind: 'EXTRA_USERS' as const,
                description: `Usuarios adicionales (${value} − ${pricing.includedUsers} incluidos)`,
                quantity: amounts.extraUsers,
                unitPrice: pricing.extraUserPrice,
                amount: amounts.extraAmount,
              },
            ]
          : []),
      ];
      await tx.platformInvoiceLine.createMany({
        data: lines.map((l) => ({ tenantId, invoiceId: id, ...l })),
      });
    }

    await tx.$executeRaw`UPDATE billing_periods SET status = 'CLOSED', closed_at = ${now} WHERE id = ${period.id}::uuid`;

    // Un período cortado por un upgrade ya tiene sucesor (la suscripción nueva); la anterior no avanza.
    if (period.cut_off || !sub.is_current) return;
    if (sub.next_plan_version_id && sub.next_interval) {
      // Downgrade programado (billing §7): la suscripción nueva empieza al terminar este período.
      await tx.$executeRaw`
        UPDATE subscriptions SET is_current = NULL, next_plan_version_id = NULL, updated_at = now()
         WHERE id = ${period.subscription_id}::uuid`;
      await tx.$executeRaw`
        INSERT INTO subscriptions (id, tenant_id, plan_version_id, status, current_period_start, current_period_end,
                                   is_current, updated_at)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${sub.next_plan_version_id}::uuid, ${sub.status}::subscription_status,
                ${period.period_end}::date,
                (${period.period_end}::date + make_interval(months => ${INTERVAL_MONTHS[sub.next_interval]}::int))::date,
                true, now())`;
      return;
    }
    // Avanza la suscripción a su período siguiente (lo abre ensureOpenPeriod).
    await tx.$executeRaw`
      UPDATE subscriptions
         SET current_period_start = ${period.period_end}::date,
             current_period_end = (${period.period_end}::date
               + make_interval(months => ${INTERVAL_MONTHS[sub.billing_interval]}::int))::date,
             updated_at = now()
       WHERE id = ${period.subscription_id}::uuid AND current_period_start = ${period.period_start}::date`;
  }
}
