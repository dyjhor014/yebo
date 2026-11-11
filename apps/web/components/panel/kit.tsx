'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '@/lib/site-api';

/** Piezas comunes de las secciones del panel (Fase 6.4b, maqueta aprobada): cabecera, tarjetas, chips y fechas. */

export const CARD = 'flex flex-col gap-3 rounded-xl border border-divider bg-raised p-5';
export const CARD_TITLE = 'font-display text-lg font-extrabold tracking-[-0.01em]';
export const ROW_ACTION =
  'inline-flex min-h-11 items-center rounded-[var(--radius-control)] px-2.5 text-sm font-semibold text-ink underline underline-offset-4 hover:bg-ink/5 disabled:opacity-60';
export const PAGE_BODY = 'flex w-full max-w-[72rem] flex-col gap-4 px-4 py-6 sm:px-8 lg:px-10';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-divider bg-raised px-4 py-5 sm:px-8 lg:px-10">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-[1.625rem] font-extrabold tracking-[-0.02em]">{title}</h1>
        <p className="text-sm text-ink-muted">{subtitle}</p>
      </div>
      {actions && <div className="flex flex-wrap gap-x-3 gap-y-2">{actions}</div>}
    </header>
  );
}

export type ChipTone = 'ok' | 'warn' | 'bad' | 'none';

const CHIP: Record<ChipTone, string> = {
  ok: 'bg-action/20 text-ink',
  warn: 'bg-warning-surface text-warning',
  bad: 'bg-danger-surface text-danger',
  none: 'bg-ink/8 text-ink',
};

export function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-[0.8125rem] font-semibold whitespace-nowrap ${CHIP[tone]}`}
    >
      {children}
    </span>
  );
}

/** Mensaje vacío dentro de una tarjeta: qué falta y cómo empezar. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[var(--radius-control)] bg-canvas px-4 py-3.5 text-sm leading-5">{children}</p>
  );
}

const DATE = new Intl.DateTimeFormat('es-PE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Fecha de calendario `AAAA-MM-DD` sin ambigüedad: «11 nov. 2026». */
export function fmtDate(iso: string): string {
  return DATE.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
}

/** Hoy en la zona horaria de la empresa (las fechas de calendario de la API son de la empresa). */
export function today(timeZone = 'America/Lima'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

export function daysUntil(iso: string, timeZone?: string): number {
  return Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today(timeZone)}T00:00:00Z`)) / 86_400_000,
  );
}

export const fmtNumber = (n: number) => n.toLocaleString('es-PE', { maximumFractionDigits: 2 });

/** Carga de datos con estado: `reload` vuelve a pedirlos tras un cambio. */
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // La primera función basta: las secciones la definen en línea y no cambia su significado entre renders.
  const loader = useRef(load);
  const reload = useCallback(() => {
    setError(null);
    return loader
      .current()
      .then((d) => setData(d))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, setData };
}

/** Anuncio cortés para lectores de pantalla (resultado de una acción). */
export function LiveStatus({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="px-1 py-6 text-ink-muted">
      Cargando {what}…
    </p>
  );
}

/** Casilla con etiqueta a la derecha y área táctil de 44 px. */
export function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[0.9375rem]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-5 shrink-0"
      />
      {label}
    </label>
  );
}
