'use client';

import type { PlatformRole } from '@yebo/contracts';
import { Logo } from '@yebo/ui/logo';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { post } from '@/lib/api';
import { SessionGate } from './session';

const ROLE_LABEL: Record<PlatformRole, string> = {
  SUPERADMIN: 'Superadmin',
  BILLING: 'Cobros',
  SUPPORT: 'Soporte',
  VIEWER: 'Solo lectura',
};

/** Secciones del carril. Las de la 4.7b se añaden aquí cuando existan sus pantallas (sin enlaces muertos). */
const SECTIONS = [{ href: '/empresas', label: 'Empresas', icon: 'building' as const }];

function RailIcon({ name }: { name: 'building' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-5"
    >
      {name === 'building' && (
        <>
          <path d="M3 21h18" />
          <path d="M5 21V7l7-4 7 4v14" />
          <path d="M9 21v-6h6v6" />
        </>
      )}
    </svg>
  );
}

/**
 * Estructura del panel (maqueta 4.7 v2): carril navy con las secciones y la sesión; superficie clara de trabajo.
 * En pantallas estrechas el carril se compacta en una banda superior.
 */
export function PanelShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [leaving, setLeaving] = useState(false);
  async function signOut() {
    setLeaving(true);
    await post('/api/v1/platform/auth/logout').catch(() => undefined);
    window.location.assign('/login');
  }
  return (
    <SessionGate>
      {(session) => (
        <div className="flex min-h-dvh flex-col bg-canvas text-ink lg:flex-row">
          <aside className="yebo-rail flex flex-col gap-4 bg-rail px-4 py-4 text-on-rail lg:sticky lg:top-0 lg:h-dvh lg:w-64 lg:shrink-0 lg:justify-between lg:gap-8 lg:px-5 lg:py-7">
            <div className="flex flex-col gap-4 lg:gap-9">
              <div className="flex flex-col gap-1 px-2">
                <Logo className="text-[1.375rem]" />
                <span className="text-xs font-semibold text-on-rail-muted">Panel de plataforma</span>
              </div>
              <nav aria-label="Secciones del panel" className="flex gap-1 overflow-x-auto lg:flex-col">
                {SECTIONS.map((s) => {
                  const active = path === s.href || path.startsWith(`${s.href}/`);
                  return (
                    <Link
                      key={s.href}
                      href={s.href}
                      aria-current={active ? 'true' : undefined}
                      className={`flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-[0.9375rem] whitespace-nowrap ${
                        active
                          ? 'bg-rail-track font-semibold text-on-rail'
                          : 'font-medium text-on-rail-muted hover:text-on-rail'
                      }`}
                    >
                      <span className={active ? 'text-rail-accent' : undefined}>
                        <RailIcon name={s.icon} />
                      </span>
                      {s.label}
                    </Link>
                  );
                })}
              </nav>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-rail-track px-2 pt-4 lg:flex-col lg:items-start">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold">{session.fullName}</span>
                <span className="text-[0.8125rem] text-on-rail-muted">
                  {ROLE_LABEL[session.role]} · MFA activa
                </span>
              </div>
              <button
                type="button"
                onClick={signOut}
                disabled={leaving}
                aria-busy={leaving || undefined}
                className="min-h-11 text-sm font-semibold text-on-rail-muted underline underline-offset-4 hover:text-on-rail"
              >
                {leaving ? 'Cerrando sesión…' : 'Cerrar sesión'}
              </button>
            </div>
          </aside>
          <main className="flex min-w-0 flex-1 flex-col gap-6 px-4 py-6 sm:px-8 lg:px-14 lg:py-8">
            {children}
          </main>
        </div>
      )}
    </SessionGate>
  );
}
