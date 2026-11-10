'use client';

import {
  SupportGrantsResponseSchema,
  SupportHandoffResponseSchema,
  type SupportGrant,
} from '@yebo/contracts';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/components/session';
import { Pill } from '@/components/status-pill';
import { Alert, SECONDARY } from '@/components/ui';
import { ApiError, get, post } from '@/lib/api';

const STATUS: Record<SupportGrant['status'], { label: string; tone: 'ok' | 'warning' | 'neutral' }> = {
  PENDING_APPROVAL: { label: 'Pendiente de aprobación', tone: 'warning' },
  ACTIVE: { label: 'Activo', tone: 'ok' },
  EXPIRED: { label: 'Caducado', tone: 'neutral' },
  REVOKED: { label: 'Revocado', tone: 'neutral' },
};

/** Pestaña «Accesos de soporte» (Fase 4.6): quién, por qué, alcance, vigencia y cada petición registrada. */
export function SupportTab({
  tenantId,
  timezone,
  refreshKey,
}: {
  tenantId: string;
  timezone: string;
  refreshKey: number;
}) {
  const session = useSession();
  const [grants, setGrants] = useState<SupportGrant[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  });
  const base = `/api/v1/platform/tenants/${tenantId}/support-grants`;

  const load = useCallback(() => {
    get(base, SupportGrantsResponseSchema)
      .then((r) => setGrants(r.grants))
      .catch((e: Error) => setFailure(e.message));
  }, [base]);
  useEffect(load, [load, refreshKey]);

  async function act(id: string, kind: 'revoke' | 'enter') {
    setBusy(id);
    setFailure(null);
    try {
      if (kind === 'enter') {
        const h = await post(`${base}/${id}/handoff`, undefined, SupportHandoffResponseSchema);
        window.open(h.url, '_blank', 'noopener,noreferrer');
      } else {
        await post(`${base}/${id}/revoke`);
        load();
      }
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo completar la acción.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="soporte" className="rounded-xl border border-divider bg-raised">
      <h2 id="soporte" className="border-b border-divider px-5 py-4 font-display text-lg font-bold">
        Accesos de soporte
      </h2>
      {failure && (
        <div className="px-5 pt-4">
          <Alert>{failure}</Alert>
        </div>
      )}
      {grants === null && !failure && <p className="px-5 py-6 text-ink-muted">Cargando…</p>}
      {grants?.length === 0 && (
        <p className="px-5 py-6 text-ink-muted">Nadie del staff ha accedido a esta empresa.</p>
      )}
      <ul>
        {grants?.map((g) => {
          const mine = g.staffEmail === session.email;
          const open = g.status === 'ACTIVE' || g.status === 'PENDING_APPROVAL';
          return (
            <li key={g.id} className="flex flex-col gap-2 border-t border-divider px-5 py-4 first:border-t-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">
                  {g.staffName} · {g.scope === 'READ_ONLY' ? 'solo consulta' : 'completo'}
                </span>
                <Pill tone={STATUS[g.status].tone}>{STATUS[g.status].label}</Pill>
              </div>
              <p className="text-[0.9375rem]">{g.reason}</p>
              <p className="text-sm text-ink-muted">
                {fmt.format(new Date(g.startsAt))} – {fmt.format(new Date(g.expiresAt))} · {g.accesses.length}{' '}
                peticiones registradas
              </p>
              {open && (
                <div className="flex flex-wrap gap-3">
                  {mine && g.status === 'ACTIVE' && (
                    <button
                      type="button"
                      onClick={() => act(g.id, 'enter')}
                      disabled={busy === g.id}
                      className={SECONDARY}
                    >
                      Entrar a la empresa
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => act(g.id, 'revoke')}
                    disabled={busy === g.id}
                    className="min-h-11 px-2 font-semibold text-danger underline underline-offset-4"
                  >
                    Revocar
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
