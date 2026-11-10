'use client';

import type {
  Invoice,
  PlanVersion,
  RecordPaymentResponse,
  TenantBillingResponse,
  TenantDetail,
  TenantUsageResponse,
} from '@yebo/contracts';
import { useState } from 'react';
import { can, useSession } from '@/components/session';
import { Pill } from '@/components/status-pill';
import { Success } from '@/components/ui';
import { addDays, date, money, period, today } from '@/lib/format';
import { ReversePayment } from './actions/reverse-payment';
import { RecordPayment } from './record-payment';

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

/** Pestaña «Facturación y consumo» (maqueta 4.7 v2): plan, período, facturas, pagos, registrar y anular. */
export function BillingTab({
  tenant,
  billing,
  plan,
  usage,
  suspendsOn,
  onChanged,
}: {
  tenant: TenantDetail;
  billing: TenantBillingResponse;
  plan: { name: string; version: PlanVersion } | null;
  usage: TenantUsageResponse | null;
  suspendsOn: string | null;
  onChanged: () => void;
}) {
  const session = useSession();
  const [result, setResult] = useState<string | null>(null);
  const [reversing, setReversing] = useState<{ id: string; summary: string; overdue: boolean } | null>(null);
  const tz = tenant.timezone;
  const todayLocal = today(tz);
  const sub = tenant.subscription;
  const peak = usage?.days.reduce<number | null>((m, d) => Math.max(m ?? 0, d.peakConcurrent), null) ?? null;
  const payments = billing.invoices
    .flatMap((i) => i.payments.map((p) => ({ ...p, invoice: i })))
    .sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const canCollect = can(session, 'platform.billing.manage');

  function report(kind: 'recorded' | 'reversed', r: RecordPaymentResponse) {
    const inv = r.invoice;
    const balance =
      inv.balance === '0.00'
        ? 'La factura queda pagada.'
        : `Saldo de la factura: ${money(inv.balance, inv.currency)}.`;
    const status =
      r.tenantStatus === 'ACTIVE' && tenant.status !== 'ACTIVE'
        ? ' La empresa vuelve a «Al día».'
        : r.tenantStatus === 'PAST_DUE' && tenant.status !== 'PAST_DUE'
          ? ' La empresa vuelve a «Pago vencido».'
          : '';
    setResult(
      `${kind === 'recorded' ? 'Pago registrado' : 'Pago anulado'} en ${inv.code}. ${balance}${status}`,
    );
    setReversing(null);
    onChanged();
  }

  return (
    <>
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

      {result && <Success>{result}</Success>}

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
                {payments.map((p) => {
                  const summary = `${money(p.amount, p.invoice.currency)} · ${METHOD[p.method]} ${p.reference} · ${date(today(tz, new Date(p.paidAt)))} · ${p.invoice.code}`;
                  const reversed = p.status === 'REVERSED';
                  return (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-divider px-5 py-3 first:border-t-0"
                    >
                      <span className={reversed ? 'text-ink-muted line-through decoration-1' : undefined}>
                        <strong className="tabular-nums">{money(p.amount, p.invoice.currency)}</strong> ·{' '}
                        {METHOD[p.method]} {p.reference} · {date(today(tz, new Date(p.paidAt)))} ·{' '}
                        {p.invoice.code}
                      </span>
                      {reversed ? (
                        <span className="flex flex-col items-end gap-0.5 text-right">
                          <Pill tone="neutral">Anulado</Pill>
                          {p.reversedAt && (
                            <span className="text-[0.8125rem] text-ink-muted">
                              {date(today(tz, new Date(p.reversedAt)))}
                              {p.reversalReason ? ` · ${p.reversalReason}` : ''}
                            </span>
                          )}
                        </span>
                      ) : (
                        canCollect &&
                        p.invoice.status !== 'VOID' && (
                          <button
                            type="button"
                            onClick={() =>
                              setReversing({ id: p.id, summary, overdue: p.invoice.dueDate < todayLocal })
                            }
                            aria-label={`Anular el pago de ${summary}`}
                            className="min-h-11 px-2 text-sm font-semibold text-danger underline underline-offset-4"
                          >
                            Anular
                          </button>
                        )
                      )}
                    </li>
                  );
                })}
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
              onRecorded={(r) => report('recorded', r)}
            />
          </section>
        )}
      </div>

      {reversing && (
        <ReversePayment
          tenantId={tenant.id}
          paymentId={reversing.id}
          summary={reversing.summary}
          overdueIfReversed={reversing.overdue}
          onClose={() => setReversing(null)}
          onReversed={(r) => report('reversed', r)}
        />
      )}
    </>
  );
}

export const periodLastDay = (t: TenantDetail) =>
  t.subscription ? addDays(t.subscription.currentPeriodEnd, -1) : null;
