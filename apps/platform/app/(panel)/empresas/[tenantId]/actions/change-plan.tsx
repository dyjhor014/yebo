'use client';

import {
  ChangePlanResponseSchema,
  type ChangePlanResponse,
  type Plan,
  type PlanVersion,
} from '@yebo/contracts';
import { useState } from 'react';
import { Dialog } from '@/components/dialog';
import { Alert, PRIMARY, SECONDARY, Select, Success, Textarea } from '@/components/ui';
import { ApiError, post } from '@/lib/api';
import { date, money } from '@/lib/format';

/**
 * «Cambiar plan» (decisión del 2026-11-10): upgrade desde hoy (corta y prorratea el período en curso, el ciclo
 * nuevo empieza hoy y se cobra al cerrar); downgrade desde el período siguiente. La API decide cuál es cuál.
 */
export function ChangePlan({
  tenantId,
  tradeName,
  plans,
  currentVersionId,
  onClose,
  onChanged,
}: {
  tenantId: string;
  tradeName: string;
  plans: Plan[];
  currentVersionId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const published = plans.flatMap((p) =>
    p.versions
      .filter((v) => v.status === 'PUBLISHED' && v.id !== currentVersionId)
      .map((v) => ({ plan: p, v })),
  );
  const [versionId, setVersionId] = useState(published[0]?.v.id ?? '');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<ChangePlanResponse | null>(null);
  const reasonError = tried && reason.trim().length < 3 ? 'Escribe el motivo (al menos 3 caracteres).' : null;
  const label = (p: Plan, v: PlanVersion) =>
    `${p.name} (versión ${v.version}) · ${money(v.basePrice, v.currency)} · ${v.includedUsers} usuarios incluidos · ${money(v.extraUserPrice, v.currency)} por adicional`;

  async function apply() {
    setTried(true);
    if (!versionId || reason.trim().length < 3) return;
    setBusy(true);
    setFailure(null);
    try {
      setDone(
        await post(
          `/api/v1/platform/tenants/${tenantId}/subscription/plan`,
          { planVersionId: versionId, reason: reason.trim() },
          ChangePlanResponseSchema,
        ),
      );
      onChanged();
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo cambiar el plan.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Cambiar plan" description={tradeName} onRequestClose={onClose} wide>
      {done ? (
        <>
          <Success>
            {done.kind === 'UPGRADE'
              ? `Upgrade aplicado desde el ${date(done.effectiveOn)}: el período en curso se cerró prorrateado y el ciclo nuevo empieza hoy; se cobra al cerrar.`
              : `Downgrade programado: rige desde el ${date(done.effectiveOn)}, al empezar el período siguiente. El período en curso se cobra completo.`}
          </Success>
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className={SECONDARY}>
              Listo
            </button>
          </div>
        </>
      ) : published.length === 0 ? (
        <p>No hay otras versiones de plan publicadas.</p>
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
          <Select
            label="Plan nuevo"
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
            hint="Upgrade: desde hoy, con prorrateo del período en curso. Downgrade: desde el período siguiente."
          >
            {published.map(({ plan, v }) => (
              <option key={v.id} value={v.id}>
                {label(plan, v)}
              </option>
            ))}
          </Select>
          <Textarea
            label="Motivo"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            error={reasonError}
          />
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={onClose} className={SECONDARY}>
              Cancelar
            </button>
            <button type="submit" disabled={busy} aria-busy={busy || undefined} className={PRIMARY}>
              {busy ? 'Cambiando plan…' : 'Cambiar plan'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
