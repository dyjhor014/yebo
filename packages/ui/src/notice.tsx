import type { ReactNode } from 'react';
import { Icon } from './icon';

/**
 * Aviso dentro del flujo (no modal). `danger` se anuncia de inmediato (role="alert"); `info`, con cortesía.
 * Sin bordes laterales de color: el estado lo dan el icono, el fondo y el texto.
 */
export function Notice({ tone = 'danger', children }: { tone?: 'danger' | 'info'; children: ReactNode }) {
  const danger = tone === 'danger';
  return (
    <div
      role={danger ? 'alert' : 'status'}
      className={`flex gap-3 rounded-[var(--radius-control)] px-4 py-3 text-sm leading-6 ${
        danger ? 'bg-danger-surface text-danger' : 'bg-ink/5 text-ink'
      }`}
    >
      <Icon name="alert" className="mt-0.5 size-5 shrink-0" />
      <div className="text-pretty">{children}</div>
    </div>
  );
}
