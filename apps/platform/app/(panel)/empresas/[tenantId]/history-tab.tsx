'use client';

import type { TenantDetail } from '@yebo/contracts';
import { STATUS_LABEL } from '@/lib/tenants';

/** Pestaña «Historial»: cambios de estado, del más reciente al más antiguo, con su motivo y su autor. */
export function HistoryTab({ tenant }: { tenant: TenantDetail }) {
  const fmt = new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tenant.timezone,
  });
  const items = [...tenant.statusHistory].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return (
    <section aria-labelledby="historial" className="rounded-xl border border-divider bg-raised">
      <h2 id="historial" className="border-b border-divider px-5 py-4 font-display text-lg font-bold">
        Cambios de estado
      </h2>
      <ol>
        {items.map((h, i) => (
          <li
            key={`${h.occurredAt}-${i}`}
            className="flex flex-col gap-0.5 border-t border-divider px-5 py-3.5 first:border-t-0"
          >
            <span className="font-semibold">
              {h.fromStatus ? `${STATUS_LABEL[h.fromStatus]} → ` : 'Alta como '}
              {STATUS_LABEL[h.toStatus]}
            </span>
            <span className="text-sm text-ink-muted">
              {fmt.format(new Date(h.occurredAt))} · {h.actorPlatformUserId ? 'por el staff' : 'automático'} ·{' '}
              {h.reason}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
