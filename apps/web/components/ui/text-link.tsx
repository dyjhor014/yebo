import type { ReactNode } from 'react';

/** Enlace de texto: navy (15,7:1) con subrayado teal decorativo; el teal no puede ser texto sobre claro (1,96:1). */
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="font-medium text-ink underline decoration-action decoration-2 underline-offset-4 hover:decoration-ink"
    >
      {children}
    </a>
  );
}
