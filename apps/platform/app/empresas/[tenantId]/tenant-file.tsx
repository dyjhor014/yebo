'use client';

import {
  PlansResponseSchema,
  TenantBillingResponseSchema,
  TenantDetailSchema,
  TenantUsageResponseSchema,
  type Invoice,
  type PlanVersion,
  type RecordPaymentResponse,
  type TenantBillingResponse,
  type TenantDetail,
  type TenantUsageResponse,
} from '@yebo/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { can, useSession } from '@/components/session';
import { Pill } from '@/components/status-pill';
import { ApiError, get } from '@/lib/api';
import { addDays, date, money, period, today } from '@/lib/format';
import { journey } from '@/lib/journey';
import { operationLine } from '@/lib/tenants';
import { RecordPayment } from './record-payment';

type Data = {
  tenant: TenantDetail;
  billing: TenantBillingResponse;
  plan: { name: string; version: PlanVersion } | null;
  usage: TenantUsageResponse | null;
};

const INVOICE_STATUS: Record<
  Invoice['status'],
  { label: string; tone: 'ok' | 'warning' | 'danger' | 'neutral' }
> = {
  DRAFT: { label: 'Borrador', tone: 'neutral' },
  ISSUED: { label: 'Emitida', tone: 'neutral' },
  PARTIALLY_PAID: { label: 'Pago parcial', tone: 'neutral' },
  OVERDUE: { label: 'Vencida', tone: 'warning' },
  PAID: { label: 'Pagada', tone: 'ok' },
  VOID: { label: 'Anulada', tone: 'neutral' },
};
const METHOD: Record<string, string> = {
  BANK_TRANSFER: 'transferencia',
  CASH: 'efectivo',
  CARD: 'tarjeta',
  OTHER: 'otro método',
};

/** Ficha de empresa · Facturación y consumo (maqueta 4.7 v2). */
export function TenantFile({ tenantId }: { tenantId: string }) {
  const session = useSession();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const base = `/api/v1/platform/tenants/${tenantId}`;
      const [tenant, billing, plans] = await Promise.all([
        get(base, TenantDetailSchema),
        get(`${base}/billing`, TenantBillingResponseSchema),
        get('/api/v1/platform/plans', PlansResponseSchema),
      ]);
      const sub = tenant.subscription;
      const found = sub
        ? plans.plans
            .flatMap((p) => p.versions.map((v) => ({ name: p.name, version: v })))
            .find((x) => x.version.id === sub.planVersionId)
        : undefined;
      const usage = sub
        ? await get(
            `${base}/usage?from=${sub.currentPeriodStart}&to=${addDays(sub.currentPeriodEnd, -1)}`,
            TenantUsageResponseSchema,
          )
        : null;
      setData({ tenant, billing, plan: found ?? null, usage });
    } catch (e) {
      setError(
        e instanceof ApiError
          ? { status: e.status, message: e.message }
          : { status: 0, message: 'No se pudo cargar la ficha. Recarga la página.' },
      );
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb name={null} />
        <p role="alert" className="rounded-[var(--radius-control)] bg-danger-surface px-4 py-3 text-danger">
          {error.status === 404 ? 'Esta empresa no existe.' : error.message}
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <p role="status" className="text-ink-muted">
        Cargando la ficha…
      </p>
    );
  }

  const { tenant, billing, plan, usage } = data;
  const tz = tenant.timezone;
  const todayLocal = today(tz);
  const policy = plan?.version.suspensionPolicy;
  const grace = policy?.pastDueGraceDays ?? 7;
  const sub = tenant.subscription;
  const trip = journey({
    status: tenant.status,
    timezone: tz,
    statusChangedAt: tenant.statusChangedAt,
    trialEndsAt: tenant.trialEndsAt,
    cancelledAt: tenant.cancelledAt,
    history: [...tenant.statusHistory].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
    periodLastDay: sub ? addDays(sub.currentPeriodEnd, -1) : null,
    pastDueGraceDays: grace,
    cancelledClosingDays: policy?.cancelledClosingDays ?? 30,
  });
  const suspendsOn =
    tenant.status === 'PAST_DUE' ? date(addDays(today(tz, new Date(tenant.statusChangedAt)), grace)) : null;
  const peak = usage?.days.reduce<number | null>((m, d) => Math.max(m ?? 0, d.peakConcurrent), null) ?? null;
  const payments = billing.invoices
    .flatMap((i) => i.payments.map((p) => ({ ...p, invoice: i.code, currency: i.currency })))
    .sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const canCollect = can(session, 'platform.billing.manage');

  function recorded(r: RecordPaymentResponse) {
    const settled = r.invoice.balance === '0.00';
    setResult(
      `Pago registrado en ${r.invoice.code}. ` +
        (settled
          ? 'La factura queda pagada. '
          : `Quedan ${money(r.invoice.balance, r.invoice.currency)} pendientes. `) +
        (r.tenantStatus === 'ACTIVE' && tenant.status !== 'ACTIVE' ? 'La empresa vuelve a «Al día».' : ''),
    );
    void load();
  }

  return (
    <>
      <Breadcrumb name={tenant.tradeName} />

      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-[1.875rem] font-extrabold tracking-[-0.02em]">{tenant.tradeName}</h1>
        <p className="text-sm text-ink-muted">
          {[
            tenant.domains.find((d) => d.isPrimary)?.host,
            operationLine({
              modalities: [...new Set(tenant.services.filter((s) => s.enabled).map((s) => s.modality))],
              services: [...new Set(tenant.services.filter((s) => s.enabled).map((s) => s.service))],
            }),
            `${tenant.taxIdType} ${tenant.taxId}`,
            tz === 'America/Lima' ? 'hora de Lima' : tz,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </header>

      <section
        aria-label="Trayecto de la empresa"
        className="yebo-rail flex flex-col gap-3.5 rounded-xl bg-rail px-6 py-5 text-on-rail"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[0.8125rem] font-semibold text-on-rail-muted">Trayecto</span>
          <span className="text-[0.9375rem] font-semibold text-rail-highlight">{trip.next}</span>
        </div>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {trip.stops.map((s) => (
            <li
              key={s.status}
              aria-current={s.state === 'current' ? 'step' : undefined}
              className="flex flex-col gap-2"
            >
              <span
                className={`h-1 rounded-full ${
                  s.state === 'current'
                    ? 'bg-rail-highlight'
                    : s.state === 'done'
                      ? 'bg-rail-accent'
                      : 'bg-rail-track'
                }`}
              />
              <span className={`text-sm font-semibold ${s.state === 'pending' ? 'text-on-rail-muted' : ''}`}>
                {s.label}
                {s.state === 'current' && <span className="sr-only"> (estado actual)</span>}
              </span>
              <span className="text-[0.8125rem] text-on-rail-muted">{s.note}</span>
            </li>
          ))}
        </ol>
      </section>

      <nav aria-label="Secciones de la empresa" className="flex flex-wrap gap-1 border-b border-divider">
        <span
          aria-current="page"
          className="-mb-px inline-flex min-h-11 items-center border-b-[3px] border-control-strong px-3.5 font-semibold"
        >
          Facturación y consumo
        </span>
      </nav>

      <section aria-label="Plan y período" className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5 rounded-xl border border-divider bg-raised px-5 py-4">
          <span className="text-[0.8125rem] font-semibold text-ink-muted">Plan vigente</span>
          {plan ? (
            <>
              <span className="font-display text-xl font-extrabold">
                {plan.name} (versión {plan.version.version})
              </span>
              <span className="text-sm">
                {money(plan.version.basePrice, plan.version.currency)} por período,{' '}
                {plan.version.includedUsers} usuarios incluidos
              </span>
              <span className="text-sm text-ink-muted">
                {money(plan.version.extraUserPrice, plan.version.currency)} por usuario adicional · se paga a{' '}
                {plan.version.paymentTermsDays} días de la emisión
              </span>
            </>
          ) : (
            <span className="text-sm text-ink-muted">Sin suscripción vigente.</span>
          )}
        </div>
        <div className="flex flex-col gap-1.5 rounded-xl border border-divider bg-raised px-5 py-4">
          <span className="text-[0.8125rem] font-semibold text-ink-muted">Período en curso</span>
          {sub ? (
            <>
              <span className="font-display text-xl font-extrabold">
                {period(sub.currentPeriodStart, sub.currentPeriodEnd)}
              </span>
              <span className="text-sm">
                {peak === null
                  ? 'Aún sin días medidos en este período.'
                  : `Pico de usuarios hasta hoy: ${peak}${plan ? ` de ${plan.version.includedUsers} incluidos` : ''}`}
              </span>
              <span className="text-sm text-ink-muted">Provisional: el pico se fija al cerrar cada día.</span>
            </>
          ) : (
            <span className="text-sm text-ink-muted">—</span>
          )}
        </div>
      </section>

      {result && (
        <p role="status" className="rounded-[var(--radius-control)] bg-action/20 px-4 py-3 text-[0.9375rem]">
          {result}
        </p>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_34rem] flex-col gap-5">
          <section aria-labelledby="facturas" className="rounded-xl border border-divider bg-raised">
            <h2 id="facturas" className="border-b border-divider px-5 py-4 font-display text-lg font-bold">
              Facturas
            </h2>
            {billing.invoices.length === 0 ? (
              <p className="px-5 py-6 text-ink-muted">
                Aún no hay facturas: se emiten al cerrar cada período.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[46rem] border-collapse text-[0.9375rem]">
                  <thead>
                    <tr className="text-left text-[0.8125rem] text-ink-muted">
                      <th scope="col" className="px-5 py-3 font-semibold">
                        Factura
                      </th>
                      <th scope="col" className="px-3 py-3 font-semibold">
                        Emitida
                      </th>
                      <th scope="col" className="px-3 py-3 font-semibold">
                        Vence
                      </th>
                      <th scope="col" className="px-3 py-3 text-right font-semibold">
                        Total
                      </th>
                      <th scope="col" className="px-3 py-3 text-right font-semibold">
                        Saldo
                      </th>
                      <th scope="col" className="px-5 py-3 font-semibold">
                        Estado
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {billing.invoices.map((i) => (
                      <tr key={i.id} className="border-t border-divider">
                        <td className="px-5 py-3.5">
                          <span className="font-semibold tabular-nums">{i.code}</span>
                          <div className="mt-0.5 text-[0.8125rem] text-ink-muted">
                            {i.lines.map((l) => l.description).join(' · ')}
                          </div>
                        </td>
                        <td className="px-3 py-3.5 whitespace-nowrap">{date(i.issueDate)}</td>
                        <td className="px-3 py-3.5 whitespace-nowrap">{date(i.dueDate)}</td>
                        <td className="px-3 py-3.5 text-right tabular-nums">{money(i.total, i.currency)}</td>
                        <td className="px-3 py-3.5 text-right font-semibold tabular-nums">
                          {money(i.balance, i.currency)}
                        </td>
                        <td className="px-5 py-3.5">
                          <Pill tone={INVOICE_STATUS[i.status].tone}>{INVOICE_STATUS[i.status].label}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="pagos" className="rounded-xl border border-divider bg-raised">
            <h2 id="pagos" className="border-b border-divider px-5 py-4 font-display text-lg font-bold">
              Pagos registrados
            </h2>
            {payments.length === 0 ? (
              <p className="px-5 py-6 text-ink-muted">Sin pagos registrados.</p>
            ) : (
              <ul>
                {payments.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-divider px-5 py-3.5 first:border-t-0"
                  >
                    <span>
                      <strong className="tabular-nums">{money(p.amount, p.currency)}</strong> ·{' '}
                      {METHOD[p.method]} {p.reference} · {date(today(tz, new Date(p.paidAt)))} · {p.invoice}
                    </span>
                    {p.status === 'REVERSED' && <Pill tone="neutral">Anulado</Pill>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {canCollect && (
          <section
            aria-labelledby="registrar"
            className="flex flex-[1_1_20rem] flex-col gap-4 rounded-xl border border-divider bg-raised p-5 md:max-w-[28rem]"
          >
            <h2 id="registrar" className="font-display text-lg font-bold">
              Registrar pago
            </h2>
            <RecordPayment
              key={billing.invoices.map((i) => `${i.id}:${i.balance}`).join()}
              tenantId={tenant.id}
              invoices={billing.invoices}
              tenantStatus={tenant.status}
              todayLocal={todayLocal}
              suspendsOn={suspendsOn}
              onRecorded={recorded}
            />
          </section>
        )}
      </div>
    </>
  );
}

function Breadcrumb({ name }: { name: string | null }) {
  return (
    <nav aria-label="Ruta" className="text-sm text-ink-muted">
      <Link
        href="/empresas"
        className="font-semibold text-ink underline decoration-[var(--link-underline)] decoration-2 underline-offset-4"
      >
        Empresas
      </Link>
      {name && (
        <>
          {' '}
          <span aria-hidden="true">/</span> <span aria-current="page">{name}</span>
        </>
      )}
    </nav>
  );
}
