'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SessionView } from '@/components/auth/session-view';
import { PanelSession, usePanel } from './panel-session';

/** Secciones del carril, según el permiso de cada una (sin enlaces a lo que no se puede usar). */
const SECTIONS = [{ href: '/panel/sitio', label: 'Mi sitio', permission: 'site.manage' }] as const;

function SiteIcon() {
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 4v5" />
    </svg>
  );
}

/**
 * Panel de la empresa (Fase 5.4, maqueta aprobada): carril navy con las secciones y la sesión, superficie clara de
 * trabajo, como el panel de plataforma. En pantallas estrechas el carril se compacta en una banda con «Menú».
 */
export function PanelShell({ children }: { children: ReactNode }) {
  return (
    <div className="yebo-access min-h-dvh">
      <PanelSession
        checking={
          <p role="status" className="px-6 py-10 text-ink-muted">
            Comprobando tu sesión…
          </p>
        }
        signedOut={<SessionView company={null} state="signed-out" leaving={false} onSignOut={() => {}} />}
      >
        <Frame>{children}</Frame>
      </PanelSession>
    </div>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { company, can, signOut, leaving } = usePanel();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(false), [path]);
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink lg:flex-row">
      <aside
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            setOpen(false);
            toggle.current?.focus();
          }
        }}
        className="yebo-rail flex flex-col bg-rail px-4 py-3 text-on-rail lg:sticky lg:top-0 lg:h-dvh lg:w-64 lg:shrink-0 lg:gap-9 lg:px-5 lg:py-7"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1 px-2">
            <span className="truncate font-display text-[1.1875rem] font-extrabold tracking-[-0.02em]">
              {company.tenant.tradeName}
            </span>
            <span className="text-xs font-semibold text-on-rail-muted">Panel de la empresa · YEBO</span>
          </div>
          <button
            ref={toggle}
            type="button"
            aria-expanded={open}
            aria-controls="panel-menu"
            onClick={() => setOpen((o) => !o)}
            className="flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-3 text-[0.9375rem] font-semibold text-on-rail hover:bg-rail-track lg:hidden"
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
              {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
            {open ? 'Cerrar menú' : 'Menú'}
          </button>
        </div>
        <div
          id="panel-menu"
          className={`${open ? 'flex' : 'hidden'} flex-col gap-4 pt-3 pb-1 lg:flex lg:flex-1 lg:justify-between lg:gap-8 lg:p-0`}
        >
          <nav aria-label="Secciones del panel" className="flex flex-col gap-1">
            {SECTIONS.filter((s) => can(s.permission)).map((s) => {
              const active = path === s.href || path.startsWith(`${s.href}/`);
              return (
                <Link
                  key={s.href}
                  href={s.href}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                  className={`flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-[0.9375rem] whitespace-nowrap ${
                    active
                      ? 'bg-rail-track font-semibold text-on-rail'
                      : 'font-medium text-on-rail-muted hover:text-on-rail'
                  }`}
                >
                  <span className={active ? 'text-rail-accent' : undefined}>
                    <SiteIcon />
                  </span>
                  {s.label}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center justify-between gap-3 border-t border-rail-track px-2 pt-4 lg:flex-col lg:items-start">
            {/* En otra pestaña: no interrumpe una edición sin guardar. */}
            <a
              href="/"
              target="_blank"
              rel="noopener"
              className="min-h-11 content-center text-sm font-semibold text-on-rail-muted underline underline-offset-4 hover:text-on-rail"
            >
              Ver el portal<span className="sr-only"> (en otra pestaña)</span>
            </a>
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={leaving}
              aria-busy={leaving || undefined}
              className="min-h-11 text-sm font-semibold text-on-rail-muted underline underline-offset-4 hover:text-on-rail"
            >
              {leaving ? 'Cerrando sesión…' : 'Cerrar sesión'}
            </button>
          </div>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
