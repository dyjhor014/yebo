'use client';

import {
  AuthLogoutResponseSchema,
  AuthSessionResponseSchema,
  PublicSiteResponseSchema,
  type AuthSessionResponse,
  type PublicSiteResponse,
} from '@yebo/contracts';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { AuthRequestError, apiFetch, readCsrfCookie } from '@/lib/auth-client';

async function loadSession(): Promise<AuthSessionResponse> {
  const res = await apiFetch('/api/v1/auth/session');
  return AuthSessionResponseSchema.parse(await res.json());
}

/** Sesión de empresa; si el token caducó o cambiaron los permisos, se renueva en silencio una vez. */
async function sessionWithRefresh(): Promise<AuthSessionResponse> {
  try {
    return await loadSession();
  } catch (e) {
    if (!(e instanceof AuthRequestError) || e.status !== 401) throw e;
    await apiFetch('/api/v1/auth/refresh', { method: 'POST', csrf: readCsrfCookie() });
    return loadSession();
  }
}

export type PanelContext = {
  session: AuthSessionResponse;
  /** Datos públicos de la empresa del host: nombre, sitio publicado y servicios que opera. */
  company: PublicSiteResponse;
  can: (permission: string) => boolean;
  signOut: () => Promise<void>;
  leaving: boolean;
};

const Ctx = createContext<PanelContext | null>(null);

export function usePanel(): PanelContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePanel requiere PanelSession');
  return ctx;
}

type State =
  | { kind: 'checking' }
  | { kind: 'signed-out' }
  | { kind: 'ready'; session: AuthSessionResponse; company: PublicSiteResponse };

/**
 * Puerta del panel de la empresa: sin sesión, el aviso para volver a entrar (`signedOut`); con sesión, los hijos
 * con el contexto (permisos efectivos y empresa). La autoridad sigue siendo la API: esto solo decide qué mostrar.
 */
export function PanelSession({
  signedOut,
  checking,
  children,
}: {
  signedOut: ReactNode;
  checking: ReactNode;
  children: ReactNode;
}) {
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    Promise.all([
      sessionWithRefresh(),
      apiFetch('/api/v1/public/site').then(async (r) => PublicSiteResponseSchema.parse(await r.json())),
    ])
      .then(([session, company]) => setState({ kind: 'ready', session, company }))
      .catch(() => setState({ kind: 'signed-out' }));
  }, []);

  const signOut = useCallback(async () => {
    setLeaving(true);
    const res = await apiFetch('/api/v1/auth/logout', { method: 'POST', csrf: readCsrfCookie() }).catch(
      () => null,
    );
    const parsed = res ? AuthLogoutResponseSchema.safeParse(await res.json()) : null;
    window.location.assign(parsed?.success ? parsed.data.hubLogoutUrl : '/');
  }, []);

  if (state.kind === 'checking') return <>{checking}</>;
  if (state.kind === 'signed-out') return <>{signedOut}</>;
  const value: PanelContext = {
    session: state.session,
    company: state.company,
    can: (p) => state.session.permissions.includes(p),
    signOut,
    leaving,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
