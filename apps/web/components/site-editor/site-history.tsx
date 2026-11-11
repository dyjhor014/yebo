'use client';

import type { SiteVersionsResponse } from '@yebo/contracts';
import { Dialog } from '@yebo/ui/dialog';
import { LINK, PRIMARY, SECONDARY } from '@yebo/ui/form';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePanel } from '@/components/panel/panel-session';
import { errorMessage, getVersions, restoreVersion } from '@/lib/site-api';

type Version = SiteVersionsResponse['versions'][number];

const STATUS: Record<Version['status'], { label: string; className: string }> = {
  PUBLISHED: { label: 'Publicada', className: 'bg-action/20 text-ink' },
  DRAFT: { label: 'Borrador', className: 'bg-warning-surface text-warning' },
  ARCHIVED: { label: 'Anterior', className: 'bg-ink/[0.07] text-ink' },
};

const when = (iso: string) =>
  new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Lima',
  }).format(new Date(iso));

function describe(v: Version): string {
  if (v.status === 'DRAFT') return `Borrador · guardado el ${when(v.updatedAt)}`;
  const by = v.publishedBy?.kind === 'SUPPORT' ? 'Soporte YEBO (acceso de soporte)' : v.publishedBy?.name;
  return `Publicada el ${v.publishedAt ? when(v.publishedAt) : '—'}${by ? ` por ${by}` : ''}`;
}

/**
 * Historial del sitio (Fase 5.4): las versiones con su estado y autor. «Restaurar» publica una COPIA de una versión
 * anterior como versión nueva (la historia no se reescribe) y no toca el borrador; se confirma antes porque cambia
 * el portal al momento.
 */
export function SiteHistory() {
  const { can } = usePanel();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ from: number; as: number } | null>(null);

  const load = () =>
    getVersions()
      .then((r) => setVersions(r.versions))
      .catch((e: unknown) => setError(errorMessage(e)));
  useEffect(() => {
    if (can('site.manage')) void load();
  }, [can]);

  async function restore(version: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await restoreVersion(version);
      setDone({ from: version, as: res.published?.version ?? version });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setAsking(null);
    }
  }

  return (
    <div className="flex w-full max-w-[55rem] flex-col gap-5 self-center px-4 py-8 sm:px-8">
      <nav aria-label="Ruta" className="text-sm text-ink-muted">
        <Link href="/panel/sitio" className={LINK}>
          Mi sitio
        </Link>{' '}
        <span aria-hidden="true">/</span> <span aria-current="page">Historial</span>
      </nav>
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-[1.75rem] font-extrabold tracking-[-0.02em]">Historial del sitio</h1>
        <p className="text-[0.9375rem] text-ink-muted">
          Restaurar vuelve a publicar una versión anterior como versión nueva. Tu borrador no cambia.
        </p>
      </header>

      {!can('site.manage') && <p className="text-ink-muted">Tu acceso no incluye el sitio de la empresa.</p>}
      <div aria-live="polite" className="empty:hidden">
        {done && (
          <p className="rounded-[var(--radius-control)] bg-action/20 px-3.5 py-3 text-[0.9375rem]">
            Versión {done.from} restaurada como versión {done.as}: ya está publicada. Tu borrador sigue
            intacto.
          </p>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-[var(--radius-control)] bg-danger-surface px-3.5 py-3 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {versions && versions.length === 0 && (
        <p className="rounded-xl border border-divider bg-raised px-5 py-4 text-ink-muted">
          Aún no hay versiones: guarda o publica el sitio desde «Mi sitio».
        </p>
      )}
      {versions && versions.length > 0 && (
        <ol aria-label="Versiones" className="rounded-xl border border-divider bg-raised">
          {versions.map((v) => (
            <li
              key={v.version}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-divider px-5 py-3.5 first:border-t-0"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-semibold">Versión {v.version}</span>
                <span className="text-sm text-ink-muted">{describe(v)}</span>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`rounded-full px-2.5 py-1 text-[0.8125rem] font-semibold ${STATUS[v.status].className}`}
                >
                  {STATUS[v.status].label}
                </span>
                {v.status === 'ARCHIVED' && (
                  <button
                    type="button"
                    onClick={() => setAsking(v.version)}
                    aria-label={`Restaurar la versión ${v.version}`}
                    className={SECONDARY}
                  >
                    Restaurar
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {asking !== null && (
        <Dialog title={`¿Restaurar la versión ${asking}?`} onRequestClose={() => !busy && setAsking(null)}>
          <p className="text-[0.9375rem]">
            Se publicará al momento como una versión nueva y la publicada ahora pasará al historial. Tu
            borrador no cambia.
          </p>
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={() => setAsking(null)} disabled={busy} className={SECONDARY}>
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void restore(asking)}
              disabled={busy}
              aria-busy={busy || undefined}
              className={PRIMARY}
            >
              {busy ? 'Restaurando…' : `Restaurar y publicar`}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
