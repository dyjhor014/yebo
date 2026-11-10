'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { PRIMARY, SECONDARY, Warning } from './ui';

/**
 * Enlace de un solo uso (F4-Q3), tras crear una invitación o un acceso: «Copiar» es la ÚNICA acción principal y
 * confirma con «Copiado ✓» (anunciado). Cerrar sin copiar pide confirmación: el enlace no se vuelve a mostrar.
 */
export function OneTimeLink({
  label,
  link,
  onDone,
  onAnother,
  anotherLabel,
  closeSignal = 0,
}: {
  label: string;
  link: string;
  onDone: () => void;
  onAnother?: () => void;
  anotherLabel?: string;
  /** Cambia cuando el diálogo pide cerrarse (Esc o ×): se aplica la misma confirmación que «Listo». */
  closeSignal?: number;
}) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const id = useId();
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Sin permiso de portapapeles: se selecciona para copiar a mano.
      (document.getElementById(id) as HTMLInputElement | null)?.select();
      return;
    }
    setCopied(true);
    setConfirming(false);
  }
  const done = () => (copied ? onDone() : setConfirming(true));
  const first = useRef(closeSignal);
  useEffect(() => {
    if (closeSignal !== first.current) done();
  }, [closeSignal]);
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <div className="flex gap-2">
          <input
            id={id}
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            className="min-h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-control bg-canvas px-3.5 font-mono text-[0.9375rem]"
          />
          <button type="button" onClick={copy} className={`${PRIMARY} whitespace-nowrap`}>
            {copied ? 'Copiado ✓' : 'Copiar enlace'}
          </button>
        </div>
        <span role="status" className="text-[0.8125rem] text-ink-muted">
          {copied ? 'Enlace copiado al portapapeles.' : 'Cópialo y envíalo solo a esa persona por tu canal.'}
        </span>
      </div>
      <Warning>
        No volverás a ver este enlace. Quien lo tenga puede usarlo: envíalo solo a esa persona.
      </Warning>
      {confirming && (
        <div
          role="alertdialog"
          aria-labelledby={`${id}-c`}
          className="flex flex-col gap-3 rounded-xl border-2 border-danger p-3.5"
        >
          <p id={`${id}-c`} className="font-semibold">
            ¿Cerrar sin copiar el enlace? Tendrás que crear otro.
          </p>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => setConfirming(false)} className={PRIMARY}>
              Volver y copiar
            </button>
            <button type="button" onClick={onDone} className={SECONDARY}>
              Cerrar sin copiar
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        {onAnother && (
          <button
            type="button"
            onClick={() => (copied ? onAnother() : setConfirming(true))}
            className="min-h-11 px-2 font-semibold underline decoration-[var(--link-underline)] decoration-2 underline-offset-4"
          >
            {anotherLabel}
          </button>
        )}
        <button type="button" onClick={done} className={SECONDARY}>
          Listo
        </button>
      </div>
    </>
  );
}
