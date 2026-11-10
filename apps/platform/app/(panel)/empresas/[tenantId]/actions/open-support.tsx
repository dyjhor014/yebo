'use client';

import { SupportGrantSchema, type SupportGrant } from '@yebo/contracts';
import { useState } from 'react';
import { Dialog } from '@/components/dialog';
import { Alert, PRIMARY, SECONDARY, Select, Success, Textarea } from '@/components/ui';
import { ApiError, post } from '@/lib/api';

const DURATIONS = [
  { minutes: 30, label: '30 minutos' },
  { minutes: 60, label: '1 hora' },
  { minutes: 120, label: '2 horas' },
  { minutes: 240, label: '4 horas' },
  { minutes: 480, label: '8 horas (máximo)' },
];

/** «Abrir acceso de soporte» (Fase 4.6): temporal, con motivo, visible para la empresa y revocable. */
export function OpenSupport({
  tenantId,
  tradeName,
  onClose,
  onOpened,
}: {
  tenantId: string;
  tradeName: string;
  onClose: () => void;
  onOpened: (g: SupportGrant) => void;
}) {
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<'READ_ONLY' | 'FULL'>('READ_ONLY');
  const [minutes, setMinutes] = useState(120);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [grant, setGrant] = useState<SupportGrant | null>(null);
  const reasonError = tried && reason.trim().length < 3 ? 'Escribe el motivo: la empresa lo verá.' : null;

  async function open() {
    setTried(true);
    if (reason.trim().length < 3) return;
    setBusy(true);
    setFailure(null);
    try {
      const g = await post(
        `/api/v1/platform/tenants/${tenantId}/support-grants`,
        { reason: reason.trim(), scope, durationMinutes: minutes },
        SupportGrantSchema,
      );
      setGrant(g);
      onOpened(g);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo abrir el acceso.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Abrir acceso de soporte"
      description={`${tradeName} verá quién entra, por qué y cada acción.`}
      onRequestClose={onClose}
    >
      {grant ? (
        <>
          <Success>
            {grant.status === 'PENDING_APPROVAL'
              ? 'Acceso solicitado. La empresa exige aprobarlo: podrás entrar cuando lo apruebe un administrador.'
              : 'Acceso abierto. Entra desde la pestaña «Accesos de soporte» de la ficha.'}
          </Success>
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className={SECONDARY}>
              Listo
            </button>
          </div>
        </>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void open();
          }}
        >
          {failure && <Alert>{failure}</Alert>}
          <Textarea
            label="Motivo"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            error={reasonError}
            hint="Por ejemplo, el número de ticket y qué se va a revisar."
          />
          <fieldset className="flex flex-col gap-2.5">
            <legend className="mb-1.5 text-sm font-medium">Alcance</legend>
            {(
              [
                ['READ_ONLY', 'Solo consulta', 'Ve todo; no puede cambiar nada.'],
                [
                  'FULL',
                  'Completo',
                  'Puede hacer cambios en nombre de la empresa. Úsalo solo si hace falta.',
                ],
              ] as const
            ).map(([value, title, text]) => (
              <label
                key={value}
                className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-divider px-3 py-2.5"
              >
                <input
                  type="radio"
                  name="scope"
                  checked={scope === value}
                  onChange={() => setScope(value)}
                  className="mt-0.5 size-[1.125rem]"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">{title}</span>
                  <span className="text-[0.8125rem] text-ink-muted">{text}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Select label="Duración" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d.minutes} value={d.minutes}>
                {d.label}
              </option>
            ))}
          </Select>
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={onClose} className={SECONDARY}>
              Cancelar
            </button>
            <button type="submit" disabled={busy} aria-busy={busy || undefined} className={PRIMARY}>
              {busy ? 'Abriendo acceso…' : 'Abrir acceso'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
