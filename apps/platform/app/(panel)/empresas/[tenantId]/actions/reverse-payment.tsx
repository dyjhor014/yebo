'use client';

import { RecordPaymentResponseSchema, type RecordPaymentResponse } from '@yebo/contracts';
import { useState } from 'react';
import { Dialog } from '@/components/dialog';
import { Alert, SECONDARY, Textarea, Warning } from '@/components/ui';
import { ApiError, post } from '@/lib/api';

/**
 * «Anular este pago» (4.7b, decisiones del 2026-11-10): motivo obligatorio; repone el saldo. Si la factura queda
 * vencida y la empresa estaba «Al día», vuelve a «Pago vencido».
 */
export function ReversePayment({
  tenantId,
  paymentId,
  summary,
  overdueIfReversed,
  onClose,
  onReversed,
}: {
  tenantId: string;
  paymentId: string;
  summary: string;
  overdueIfReversed: boolean;
  onClose: () => void;
  onReversed: (r: RecordPaymentResponse) => void;
}) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const reasonError = tried && reason.trim().length < 3 ? 'Escribe el motivo (al menos 3 caracteres).' : null;

  async function reverse() {
    setTried(true);
    if (reason.trim().length < 3) return;
    setBusy(true);
    setFailure(null);
    try {
      onReversed(
        await post(
          `/api/v1/platform/tenants/${tenantId}/payments/${paymentId}/reverse`,
          { reason: reason.trim() },
          RecordPaymentResponseSchema,
        ),
      );
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo anular el pago.');
      setBusy(false);
    }
  }

  return (
    <Dialog title="Anular este pago" description={summary} onRequestClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void reverse();
        }}
      >
        {failure && <Alert>{failure}</Alert>}
        <Warning>
          El pago queda anulado (no se borra) y la factura recupera ese saldo.
          {overdueIfReversed &&
            ' La factura ya venció: si la empresa está «Al día», vuelve a «Pago vencido».'}
        </Warning>
        <Textarea
          label="Motivo"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          error={reasonError}
          hint="Por ejemplo: rebote del banco, registrado por error. Solo lo ve el staff."
        />
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" onClick={onClose} className={SECONDARY}>
            Cancelar
          </button>
          <button
            type="submit"
            disabled={busy}
            aria-busy={busy || undefined}
            className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-danger px-5 font-semibold text-canvas disabled:opacity-60"
          >
            {busy ? 'Anulando…' : 'Anular pago'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
