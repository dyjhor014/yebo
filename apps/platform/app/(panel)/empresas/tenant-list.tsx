'use client';

import { TenantsResponseSchema, type TenantOverview } from '@yebo/contracts';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { can, useSession } from '@/components/session';
import { StatusPill } from '@/components/status-pill';
import { PRIMARY } from '@/components/ui';
import { get } from '@/lib/api';
import { date, money } from '@/lib/format';
import { byUrgency, extraUsers, matches, milestoneLabel, operationLine, type Filter } from '@/lib/tenants';

/** Suma de saldos por moneda, en céntimos (sin float). */
function totals(list: TenantOverview[]): string {
  const by = new Map<string, bigint>();
  for (const t of list)
    by.set(t.currency, (by.get(t.currency) ?? 0n) + BigInt(t.outstanding.replace('.', '')));
  const parts = [...by.entries()]
    .filter(([, c]) => c > 0n)
    .map(([cur, c]) => {
      const s = c.toString().padStart(3, '0');
      return money(`${s.slice(0, -2)}.${s.slice(-2)}`, cur);
    });
  return parts.length ? parts.join(' + ') : money('0.00');
}

const CARDS: { filter: Filter; title: string }[] = [
  { filter: 'attention', title: 'Pago vencido o suspendidas' },
  { filter: 'trial', title: 'En prueba' },
  { filter: 'over-limit', title: 'Por encima de sus usuarios incluidos' },
];

/** Empresas (maqueta 4.7 v2): ordenadas por urgencia; las tarjetas de resumen filtran la lista. */
export function TenantList() {
  const session = useSession();
  const [tenants, setTenants] = useState<TenantOverview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    get('/api/v1/platform/tenants', TenantsResponseSchema)
      .then((r) => setTenants(r.tenants))
      .catch((e: Error) => setError(e.message));
  }, []);

  const sorted = useMemo(() => (tenants ? [...tenants].sort(byUrgency) : []), [tenants]);
  const visible = sorted.filter((t) => matches(t, filter));

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-[1.875rem] font-extrabold tracking-[-0.02em]">Empresas</h1>
          <p className="text-[0.9375rem] text-ink-muted">Primero las que requieren atención.</p>
        </div>
        {can(session, 'platform.tenants.manage') && (
          <Link href="/empresas/nueva" className={PRIMARY}>
            Nueva empresa
          </Link>
        )}
      </header>

      {error && (
        <p role="alert" className="rounded-[var(--radius-control)] bg-danger-surface px-4 py-3 text-danger">
          {error}
        </p>
      )}

      {tenants && (
        <>
          <section aria-label="Resumen y filtros" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {CARDS.map((c) => {
              const list = sorted.filter((t) => matches(t, c.filter));
              const pressed = filter === c.filter;
              return (
                <button
                  key={c.filter}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => setFilter(pressed ? 'all' : c.filter)}
                  className={`flex flex-col gap-1 rounded-xl border bg-raised px-5 py-4 text-left transition-colors hover:border-control-strong ${
                    pressed ? 'border-2 border-control-strong' : 'border-divider'
                  }`}
                >
                  <span className="text-[0.8125rem] font-semibold text-ink-muted">{c.title}</span>
                  <span className="font-display text-[1.75rem] font-extrabold tabular-nums">
                    {list.length}
                  </span>
                  {c.filter === 'attention' && (
                    <span className="text-sm tabular-nums">Saldo pendiente: {totals(list)}</span>
                  )}
                </button>
              );
            })}
          </section>

          <section aria-labelledby="lista" className="rounded-xl border border-divider bg-raised">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-divider px-5 py-4">
              <h2 id="lista" className="font-display text-lg font-bold">
                Lista
              </h2>
              <p role="status" className="text-sm text-ink-muted">
                {visible.length} de {sorted.length} empresas
                {filter !== 'all' && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      onClick={() => setFilter('all')}
                      className="min-h-11 font-semibold text-ink underline decoration-[var(--link-underline)] decoration-2 underline-offset-4"
                    >
                      Quitar filtro
                    </button>
                  </>
                )}
              </p>
            </div>
            {visible.length === 0 ? (
              <p className="px-5 py-10 text-center text-ink-muted">
                {sorted.length === 0
                  ? 'Aún no hay empresas. Da de alta la primera con «Nueva empresa».'
                  : 'Ninguna empresa en esta situación.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[56rem] border-collapse text-[0.9375rem]">
                  <thead>
                    <tr className="text-left text-[0.8125rem] text-ink-muted">
                      <th scope="col" className="px-5 py-3 font-semibold">
                        Empresa
                      </th>
                      <th scope="col" className="px-3 py-3 font-semibold">
                        Estado
                      </th>
                      <th scope="col" className="px-3 py-3 font-semibold">
                        Próximo hito
                      </th>
                      <th scope="col" className="px-3 py-3 font-semibold">
                        Plan
                      </th>
                      <th scope="col" className="px-3 py-3 text-right font-semibold">
                        Usuarios
                      </th>
                      <th scope="col" className="px-5 py-3 text-right font-semibold">
                        Saldo
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((t) => {
                      const extra = extraUsers(t);
                      return (
                        <tr key={t.id} className="border-t border-divider hover:bg-ink/[0.03]">
                          <td className="px-5 py-3.5">
                            <Link
                              href={`/empresas/${t.id}`}
                              className="font-semibold text-ink underline decoration-[var(--link-underline)] decoration-2 underline-offset-4"
                            >
                              {t.tradeName}
                            </Link>
                            <div className="mt-0.5 text-[0.8125rem] text-ink-muted">
                              {operationLine(t)}
                              {t.primaryHost && ` · ${t.primaryHost}`}
                            </div>
                          </td>
                          <td className="px-3 py-3.5">
                            <StatusPill status={t.status} />
                          </td>
                          <td className="px-3 py-3.5 whitespace-nowrap">
                            {t.milestone
                              ? `${milestoneLabel(t.milestone.kind)} ${date(t.milestone.date)}`
                              : '—'}
                          </td>
                          <td className="px-3 py-3.5">
                            {t.plan ? `${t.plan.name} (v${t.plan.version})` : '—'}
                          </td>
                          <td className="px-3 py-3.5 text-right tabular-nums whitespace-nowrap">
                            {t.usersPeak === null ? '—' : `${t.usersPeak}/${t.includedUsers ?? '—'}`}
                            {extra > 0 && (
                              <span className="ml-2 rounded-full bg-warning-surface px-2 py-0.5 text-[0.8125rem] font-semibold text-warning">
                                +{extra} adicionales
                              </span>
                            )}
                          </td>
                          <td
                            className={`px-5 py-3.5 text-right tabular-nums whitespace-nowrap ${t.overdue ? 'font-semibold' : ''}`}
                          >
                            {money(t.outstanding, t.currency)}
                            {t.overdue && (
                              <span className="block text-[0.8125rem] font-semibold text-warning">
                                vencido
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      {!tenants && !error && (
        <p role="status" className="text-ink-muted">
          Cargando empresas…
        </p>
      )}
    </>
  );
}
