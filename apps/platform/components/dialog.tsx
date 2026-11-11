'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Diálogo modal con <dialog> nativo (showModal): el foco queda dentro, el fondo es inerte y Esc lo cierra.
 * `onRequestClose` decide si se cierra (p. ej. pedir confirmación si hay un enlace sin copiar).
 */
export function Dialog({
  title,
  description,
  onRequestClose,
  children,
  wide = false,
}: {
  title: string;
  description?: ReactNode;
  onRequestClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-t`}
      aria-describedby={description ? `${id}-d` : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onRequestClose();
      }}
      className={`m-auto w-[calc(100%-2rem)] ${wide ? 'max-w-[40rem]' : 'max-w-[35rem]'} rounded-2xl bg-raised p-0 text-ink shadow-[0_24px_64px_rgb(16_29_43/0.35)] backdrop:bg-[rgb(16_29_43/0.55)]`}
    >
      <div className="flex items-start justify-between gap-4 px-7 pt-6 pb-2">
        <div className="flex flex-col gap-1.5">
          <h2 id={`${id}-t`} className="font-display text-2xl font-extrabold tracking-[-0.02em]">
            {title}
          </h2>
          {description && (
            <p id={`${id}-d`} className="text-[0.9375rem] text-ink-muted">
              {description}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onRequestClose}
          aria-label="Cerrar (Esc)"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] hover:bg-ink/5"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden="true"
            className="size-5"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <div className="flex flex-col gap-5 px-7 pt-4 pb-7">{children}</div>
    </dialog>
  );
}
