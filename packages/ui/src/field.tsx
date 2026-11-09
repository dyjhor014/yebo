'use client';

import { useId, useState, type InputHTMLAttributes } from 'react';
import { Icon } from './icon';

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null };

const INPUT =
  'block min-h-11 w-full rounded-[var(--radius-control)] border bg-raised px-3.5 text-base text-ink ' +
  'transition-colors duration-[var(--motion-quick)] placeholder:text-ink-muted ' +
  'hover:border-control-strong focus:border-control-strong aria-[invalid=true]:border-danger';

/** Campo con etiqueta persistente; el error queda asociado (aria-describedby) y se anuncia al aparecer. */
export function TextField({ label, error, id, ...props }: FieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const errorId = `${inputId}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        {...props}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`${INPUT} border-control`}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

/** Contraseña con botón para mostrarla (ayuda en móviles); el botón dice siempre lo que hará. */
export function PasswordField({ label, error, id, ...props }: FieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const errorId = `${inputId}-error`;
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          {...props}
          id={inputId}
          type={visible ? 'text' : 'password'}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`${INPUT} border-control pr-12`}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          aria-controls={inputId}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-[var(--radius-control)] text-ink-muted hover:text-ink"
        >
          <Icon name={visible ? 'eyeOff' : 'eye'} />
        </button>
      </div>
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string | null | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="flex items-center gap-1.5 text-sm text-danger">
      <Icon name="alert" className="size-4 shrink-0" />
      {message}
    </p>
  );
}
