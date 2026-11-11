'use client';

import {
  TENANT_MANUAL_TRANSITIONS,
  TenantDetailSchema,
  type TenantDetail,
  type TenantStatus,
} from '@yebo/contracts';
import { useState } from 'react';
import { Dialog } from '@/components/dialog';
import { Alert, PRIMARY, SECONDARY, Textarea, Warning } from '@/components/ui';
import { ApiError, post } from '@/lib/api';
import { STATUS_LABEL } from '@/lib/tenants';

const EFFECT: Partial<Record<TenantStatus, string>> = {
  SUSPENDED:
    'La empresa deja de operar (ventas, envíos, altas) hasta que se reactive. Puede consultar y pagar.',
  CANCELLED:
    'Es definitivo: la empresa entra en el período de cierre y después se archiva. No se puede deshacer.',
  PAST_DUE:
    'Se marca con pago vencido; si no se regulariza, el sistema la suspende al terminar la gracia del plan.',
  EXPIRED: 'La prueba termina ahora: la empresa solo puede consultar hasta que contrate.',
  ACTIVE: 'Vuelve a operar con normalidad.',
};

/** «Suspender o cancelar…» (acción de riesgo, separada de las demás): destino permitido y motivo obligatorio. */
export function ChangeStatus({
  tenant,
  onClose,
  onChanged,
}: {
  tenant: TenantDetail;
  onClose: () => void;
  onChanged: (t: TenantDetail) => void;
}) {
  const options = TENANT_MANUAL_TRANSITIONS[tenant.status];
  const [to, setTo] = useState<TenantStatus | null>(
    options.includes('SUSPENDED') ? 'SUSPENDED' : (options[0] ?? null),
  );
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const reasonError = tried && reason.trim().length < 3 ? 'Escribe el motivo (al menos 3 caracteres).' : null;
  const nameError =
    tried && to === 'CANCELLED' && confirmName.trim() !== tenant.tradeName
      ? `Escribe «${tenant.tradeName}» para confirmar.`
      : null;

  async function apply() {
    setTried(true);
    if (!to || reason.trim().length < 3 || (to === 'CANCELLED' && confirmName.trim() !== tenant.tradeName))
      return;
    setBusy(true);
    setFailure(null);
    try {
      onChanged(
        await post(
          `/api/v1/platform/tenants/${tenant.id}/status`,
          { to, reason: reason.trim() },
          TenantDetailSchema,
        ),
      );
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo cambiar el estado.');
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Cambiar el estado de la empresa"
      description={`${tenant.tradeName} · ahora: ${STATUS_LABEL[tenant.status]}`}
      onRequestClose={onClose}
    >
      {options.length === 0 ? (
        <>
          <p>Una empresa cancelada no cambia de estado.</p>
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className={SECONDARY}>
              Cerrar
            </button>
          </div>
        </>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void apply();
          }}
        >
          {failure && <Alert>{failure}</Alert>}
          <fieldset className="flex flex-col gap-2.5">
            <legend className="mb-1.5 text-sm font-medium">Nuevo estado</legend>
            {options.map((s) => (
              <label
                key={s}
                className={`flex items-start gap-2.5 rounded-[var(--radius-control)] border px-3 py-2.5 ${s === 'CANCELLED' ? 'border-danger' : 'border-divider'}`}
              >
                <input
                  type="radio"
                  name="to"
                  checked={to === s}
                  onChange={() => setTo(s)}
                  className="mt-0.5 size-[1.125rem]"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">{STATUS_LABEL[s]}</span>
                  <span className="text-[0.8125rem] text-ink-muted">{EFFECT[s]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Textarea
            label="Motivo"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            error={reasonError}
            hint="Queda en el historial de la empresa y en la auditoría."
          />
          {to === 'CANCELLED' && (
            <>
              <Warning>Cancelar es definitivo.</Warning>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Escribe «{tenant.tradeName}» para confirmar</span>
                <input
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  aria-invalid={nameError ? true : undefined}
                  className="min-h-11 rounded-[var(--radius-control)] border border-control bg-raised px-3.5 aria-[invalid=true]:border-2 aria-[invalid=true]:border-danger"
                />
                {nameError && <span className="text-[0.8125rem] font-semibold text-danger">{nameError}</span>}
              </label>
            </>
          )}
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={onClose} className={SECONDARY}>
              Cancelar
            </button>
            <button
              type="submit"
              disabled={busy}
              aria-busy={busy || undefined}
              className={
                to === 'CANCELLED' || to === 'SUSPENDED'
                  ? 'inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-danger px-5 font-semibold text-canvas disabled:opacity-60'
                  : PRIMARY
              }
            >
              {busy ? 'Aplicando…' : to ? `Pasar a «${STATUS_LABEL[to]}»` : 'Aplicar'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
