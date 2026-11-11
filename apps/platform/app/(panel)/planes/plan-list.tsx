'use client';

import { PlanVersionSchema, PlansResponseSchema, type Plan, type PlanVersion } from '@yebo/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '@/components/dialog';
import { can, useSession } from '@/components/session';
import { Pill } from '@/components/status-pill';
import { Alert, SECONDARY } from '@/components/ui';
import { ApiError, get, post } from '@/lib/api';
import { money } from '@/lib/format';

const STATUS = {
  DRAFT: { label: 'Borrador', tone: 'neutral' },
  PUBLISHED: { label: 'Publicada', tone: 'ok' },
  RETIRED: { label: 'Retirada', tone: 'neutral' },
} as const;
const INTERVAL = { MONTHLY: 'al mes', QUARTERLY: 'al trimestre', YEARLY: 'al año' } as const;
const METRIC = {
  PEAK_DAILY: 'pico diario',
  AVERAGE_DAILY: 'promedio diario',
  END_OF_PERIOD: 'al cierre',
} as const;

/**
 * Catálogo de planes (Fase 4.2): versiones con su precio y reglas. Publicar y retirar desde aquí; crear planes y
 * versiones sigue por la API hasta su pantalla (pendiente, ver el plan de la Fase 4).
 */
export function PlanList() {
  const session = useSession();
  const manage = can(session, 'platform.plans.manage');
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<{ plan: Plan; v: PlanVersion; op: 'publish' | 'retire' } | null>(
    null,
  );

  const load = useCallback(() => {
    get('/api/v1/platform/plans', PlansResponseSchema)
      .then((r) => setPlans(r.plans))
      .catch((e: Error) => setFailure(e.message));
  }, []);
  useEffect(load, [load]);

  async function apply() {
    if (!pending) return;
    setFailure(null);
    try {
      await post(
        `/api/v1/platform/plan-versions/${pending.v.id}/${pending.op}`,
        undefined,
        PlanVersionSchema,
      );
      load();
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo completar la acción.');
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-[1.875rem] font-extrabold tracking-[-0.02em]">Planes</h1>
        <p className="text-[0.9375rem] text-ink-muted">
          Una versión publicada no cambia: para cambiar precios se publica otra versión.
        </p>
      </header>
      {failure && <Alert>{failure}</Alert>}
      {plans === null && !failure && <p className="text-ink-muted">Cargando…</p>}
      {plans?.length === 0 && <p className="text-ink-muted">Aún no hay planes.</p>}
      {plans?.map((plan) => (
        <section
          key={plan.id}
          aria-labelledby={`p-${plan.id}`}
          className="rounded-xl border border-divider bg-raised"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-divider px-5 py-4">
            <h2 id={`p-${plan.id}`} className="font-display text-lg font-bold">
              {plan.name} <span className="font-sans text-sm font-normal text-ink-muted">· {plan.code}</span>
            </h2>
            {plan.description && <p className="text-sm text-ink-muted">{plan.description}</p>}
          </div>
          <ul>
            {[...plan.versions]
              .sort((a, b) => b.version - a.version)
              .map((v) => (
                <li
                  key={v.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-t border-divider px-5 py-3.5 first:border-t-0"
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="font-semibold">
                      Versión {v.version} · {money(v.basePrice, v.currency)} {INTERVAL[v.billingInterval]}
                    </span>
                    <span className="text-sm text-ink-muted">
                      {v.includedUsers} usuarios incluidos · {money(v.extraUserPrice, v.currency)} por
                      adicional ({METRIC[v.usageMetric]}) · pago a {v.paymentTermsDays} días
                      {v.trialDays > 0 ? ` · ${v.trialDays} días de prueba` : ''} · gracia{' '}
                      {v.suspensionPolicy.pastDueGraceDays} días · {v.modules.length} módulos
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <Pill tone={STATUS[v.status].tone}>{STATUS[v.status].label}</Pill>
                    {manage && v.status === 'DRAFT' && (
                      <button
                        type="button"
                        onClick={() => setPending({ plan, v, op: 'publish' })}
                        className={SECONDARY}
                      >
                        Publicar
                      </button>
                    )}
                    {manage && v.status === 'PUBLISHED' && (
                      <button
                        type="button"
                        onClick={() => setPending({ plan, v, op: 'retire' })}
                        className="min-h-11 px-2 font-semibold text-danger underline underline-offset-4"
                      >
                        Retirar
                      </button>
                    )}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ))}
      {pending && (
        <Dialog
          title={
            pending.op === 'publish'
              ? `¿Publicar ${pending.plan.name} versión ${pending.v.version}?`
              : `¿Retirar ${pending.plan.name} versión ${pending.v.version}?`
          }
          description={
            pending.op === 'publish'
              ? 'Una vez publicada no se puede editar: queda disponible para nuevas altas y cambios de plan.'
              : 'Deja de ofrecerse para nuevas altas y cambios de plan. Las empresas que ya la tienen la conservan.'
          }
          onRequestClose={() => setPending(null)}
        >
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={() => setPending(null)} className={SECONDARY}>
              Cancelar
            </button>
            <button
              type="button"
              onClick={apply}
              className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-action px-5 font-semibold text-on-action"
            >
              {pending.op === 'publish' ? 'Publicar' : 'Retirar'}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
