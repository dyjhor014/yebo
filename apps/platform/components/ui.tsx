'use client';

import {
  useId,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type InputHTMLAttributes,
} from 'react';

/** Piezas de formulario del panel, con los roles de semantic.css (error asociado y anunciado). */
export const INPUT =
  'min-h-11 w-full rounded-[var(--radius-control)] border border-control bg-raised px-3.5 text-base text-ink ' +
  'hover:border-control-strong focus:border-control-strong aria-[invalid=true]:border-2 aria-[invalid=true]:border-danger';

export const PRIMARY =
  'inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-action px-5 font-semibold text-on-action hover:bg-action-hover disabled:opacity-60';
export const SECONDARY =
  'inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border border-control-strong px-4 font-semibold text-ink hover:bg-ink/5 disabled:opacity-60';
export const DANGER_LINK =
  'inline-flex min-h-11 items-center px-2 font-semibold text-danger underline underline-offset-4 disabled:opacity-60';
export const LINK =
  'font-semibold text-ink underline decoration-[var(--link-underline)] decoration-2 underline-offset-4';

type Common = { label: string; hint?: ReactNode; error?: string | null };

function Wrap({ id, label, hint, error, children }: Common & { id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <span id={`${id}-m`} className="text-[0.8125rem] font-semibold text-danger">
          {error}
        </span>
      ) : (
        hint && (
          <span id={`${id}-m`} className="text-[0.8125rem] text-ink-muted">
            {hint}
          </span>
        )
      )}
    </div>
  );
}

export function Input({ label, hint, error, ...props }: Common & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error}>
      <input
        {...props}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-m` : undefined}
        className={INPUT}
      />
    </Wrap>
  );
}

export function Select({
  label,
  hint,
  error,
  children,
  ...props
}: Common & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error}>
      <select
        {...props}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-m` : undefined}
        className={INPUT}
      >
        {children}
      </select>
    </Wrap>
  );
}

export function Textarea({
  label,
  hint,
  error,
  ...props
}: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error}>
      <textarea
        {...props}
        id={id}
        rows={props.rows ?? 3}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-m` : undefined}
        className={`${INPUT} py-2.5`}
      />
    </Wrap>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-[var(--radius-control)] bg-danger-surface px-3.5 py-3 text-sm text-danger"
    >
      {children}
    </p>
  );
}

export function Success({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex gap-2.5 rounded-[var(--radius-control)] bg-action/20 px-3.5 py-3 text-[0.9375rem] leading-[1.375rem]"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="mt-0.5 size-5 shrink-0"
      >
        <path d="M4 12.5 9.5 18 20 6" />
      </svg>
      <div>{children}</div>
    </div>
  );
}

export function Warning({ children }: { children: ReactNode }) {
  return (
    <div
      role="note"
      className="rounded-[var(--radius-control)] bg-warning-surface px-3.5 py-3 text-sm leading-5 text-warning"
    >
      {children}
    </div>
  );
}
