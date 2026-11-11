import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary';

const BASE =
  'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] px-5 text-base font-semibold ' +
  'transition-colors duration-[var(--motion-quick)] disabled:cursor-not-allowed disabled:opacity-60';

const VARIANT: Record<Variant, string> = {
  /** Acción principal: relleno teal con texto navy (8,0:1). Una por pantalla. */
  primary: 'bg-action text-on-action hover:bg-action-hover active:bg-action-hover',
  /** Acción secundaria: contorno navy sobre la superficie clara. */
  secondary: 'border border-control-strong text-ink hover:bg-ink/5 active:bg-ink/10',
};

export function buttonClasses(variant: Variant = 'primary'): string {
  return `${BASE} ${VARIANT[variant]}`;
}

/** Botón con estado de carga: deshabilitado, `aria-busy` y una etiqueta que nombra la operación en curso. */
export function Button({
  variant = 'primary',
  busy = false,
  busyLabel,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  busy?: boolean;
  busyLabel?: string;
  children: ReactNode;
}) {
  return (
    <button
      {...props}
      className={buttonClasses(variant)}
      disabled={busy || props.disabled}
      aria-busy={busy || undefined}
    >
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

/** Enlace con aspecto de botón (navegación a otra pantalla o a otro dominio). */
export function ButtonLink({
  variant = 'primary',
  href,
  children,
}: {
  variant?: Variant;
  href: string;
  children: ReactNode;
}) {
  return (
    <a href={href} className={buttonClasses(variant)}>
      {children}
    </a>
  );
}
