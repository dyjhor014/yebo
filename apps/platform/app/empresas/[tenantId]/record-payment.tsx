'use client';

import {
  RecordPaymentResponseSchema,
  type Invoice,
  type PaymentMethodSchema,
  type RecordPaymentResponse,
  type TenantStatus,
} from '@yebo/contracts';
import { useId, useState } from 'react';
import type { z } from 'zod';
import { ApiError, post } from '@/lib/api';
import { date as fmtDate, money, parseAmount } from '@/lib/format';
import { paymentConsequence } from '@/lib/payment';

type Method = z.infer<typeof PaymentMethodSchema>;
const METHODS: { value: Method; label: string }[] = [
  { value: 'BANK_TRANSFER', label: 'Transferencia bancaria' },
  { value: 'CASH', label: 'Efectivo' },
  { value: 'CARD', label: 'Tarjeta' },
  { value: 'OTHER', label: 'Otro' },
];

const INPUT =
  'min-h-11 w-full rounded-[var(--radius-control)] border border-control bg-raised px-3.5 text-base text-ink ' +
  'hover:border-control-strong focus:border-control-strong aria-[invalid=true]:border-2 aria-[invalid=true]:border-danger';
const TONE = {
  neutral: 'bg-ink/5 text-ink',
  warning: 'bg-warning-surface text-warning',
  danger: 'bg-danger-surface text-danger',
};

/**
 * «Registrar pago» (maqueta 4.7 v2): importe con eco de lo que se registrará, fecha del comprobante (hoy por
 * defecto, nunca futura), método y n.º de operación, y el aviso de la consecuencia antes de confirmar. Tras
 * registrar, la ficha se recarga y se muestra el resultado.
 */
export function RecordPayment({
  tenantId,
  invoices,
  tenantStatus,
  todayLocal,
  suspendsOn,
  onRecorded,
}: {
  tenantId: string;
  invoices: Invoice[];
  tenantStatus: TenantStatus;
  todayLocal: string;
  suspendsOn: string | null;
  onRecorded: (r: RecordPaymentResponse) => void;
}) {
  const payable = invoices
    .filter((i) => ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(i.status))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const [invoiceId, setInvoiceId] = useState(payable[0]?.id ?? '');
  const invoice = payable.find((i) => i.id === invoiceId) ?? payable[0];
  const [amountText, setAmountText] = useState(invoice?.balance ?? '');
  const [paidOn, setPaidOn] = useState(todayLocal);
  const [method, setMethod] = useState<Method>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const id = useId();

  if (!invoice) {
    return <p className="text-[0.9375rem] text-ink-muted">No hay facturas con saldo pendiente.</p>;
  }

  const amount = parseAmount(amountText);
  const consequence = paymentConsequence({ amount, invoice, invoices, tenantStatus, suspendsOn });
  const amountError = tried && consequence.blocking ? consequence.text : null;
  const dateError =
    tried && (!paidOn || paidOn > todayLocal) ? 'La fecha del pago no puede ser futura.' : null;
  const referenceError = tried && !reference.trim() ? 'Escribe el n.º de operación o de recibo.' : null;

  async function submit() {
    setTried(true);
    setFailure(null);
    if (!invoice || consequence.blocking || !amount || !reference.trim() || !paidOn || paidOn > todayLocal)
      return;
    setBusy(true);
    try {
      const res = await post(
        `/api/v1/platform/tenants/${tenantId}/invoices/${invoice.id}/payments`,
        {
          amount,
          method,
          reference: reference.trim(),
          // Hoy → la API usa su hora; un día anterior → mediodía UTC, que cae en ese mismo día civil en Perú.
          ...(paidOn !== todayLocal && { paidAt: `${paidOn}T12:00:00.000Z` }),
        },
        RecordPaymentResponseSchema,
      );
      setTried(false);
      setReference('');
      onRecorded(res);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo registrar el pago. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-4"
    >
      {payable.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-inv`} className="text-sm font-medium">
            Factura
          </label>
          <select
            id={`${id}-inv`}
            value={invoice.id}
            onChange={(e) => {
              const next = payable.find((i) => i.id === e.target.value);
              setInvoiceId(e.target.value);
              if (next) setAmountText(next.balance);
            }}
            className={INPUT}
          >
            {payable.map((i) => (
              <option key={i.id} value={i.id}>
                {i.code} · saldo {money(i.balance, i.currency)}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="text-sm text-ink-muted">
          Factura {invoice.code} · saldo {money(invoice.balance, invoice.currency)} · vence el{' '}
          {fmtDate(invoice.dueDate)}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-amount`} className="text-sm font-medium">
          Importe en soles
        </label>
        <input
          id={`${id}-amount`}
          inputMode="decimal"
          autoComplete="off"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          aria-invalid={amountError ? true : undefined}
          aria-describedby={`${id}-amount-help`}
          className={INPUT}
        />
        <span id={`${id}-amount-help`} className="text-[0.8125rem] text-ink-muted">
          {amount ? `Se registrará ${money(amount, invoice.currency)}.` : 'Acepta 204.00 o 204,00.'} Máximo:
          el saldo pendiente.
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-date`} className="text-sm font-medium">
          Fecha del pago
        </label>
        <input
          id={`${id}-date`}
          type="date"
          value={paidOn}
          max={todayLocal}
          onChange={(e) => setPaidOn(e.target.value)}
          aria-invalid={dateError ? true : undefined}
          aria-describedby={`${id}-date-help`}
          className={INPUT}
        />
        <span
          id={`${id}-date-help`}
          className={`text-[0.8125rem] ${dateError ? 'font-semibold text-danger' : 'text-ink-muted'}`}
        >
          {dateError ?? 'La del comprobante; no puede ser futura.'}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-method`} className="text-sm font-medium">
          Método
        </label>
        <select
          id={`${id}-method`}
          value={method}
          onChange={(e) => setMethod(e.target.value as Method)}
          className={INPUT}
        >
          {METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-ref`} className="text-sm font-medium">
          N.º de operación o de recibo
        </label>
        <input
          id={`${id}-ref`}
          value={reference}
          maxLength={120}
          onChange={(e) => setReference(e.target.value)}
          aria-invalid={referenceError ? true : undefined}
          aria-describedby={referenceError ? `${id}-ref-error` : undefined}
          className={INPUT}
        />
        {referenceError && (
          <span id={`${id}-ref-error`} className="text-[0.8125rem] font-semibold text-danger">
            {referenceError}
          </span>
        )}
      </div>

      <div
        role="status"
        aria-live="polite"
        className={`rounded-[var(--radius-control)] px-3.5 py-3 text-sm leading-5 ${TONE[consequence.tone]}`}
      >
        {consequence.text}
      </div>

      {failure && (
        <p
          role="alert"
          className="rounded-[var(--radius-control)] bg-danger-surface px-3.5 py-3 text-sm text-danger"
        >
          {failure}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        aria-busy={busy || undefined}
        className="min-h-11 rounded-[var(--radius-control)] bg-action px-5 font-semibold text-on-action hover:bg-action-hover disabled:opacity-60"
      >
        {busy ? 'Registrando pago…' : 'Registrar pago'}
      </button>
    </form>
  );
}
