import type { ReactNode } from 'react';

/** Título y entradilla de cada pantalla de acceso: una sola jerarquía para todas (Manrope / Inter). */
export function AccessHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="font-display text-2xl leading-tight font-bold text-balance text-ink lg:text-[1.75rem]">
        {title}
      </h1>
      {children && <p className="text-base leading-6 text-pretty text-ink-muted">{children}</p>}
    </header>
  );
}
