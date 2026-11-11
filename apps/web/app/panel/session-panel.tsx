'use client';

import {
  AuthLogoutResponseSchema,
  AuthSessionResponseSchema,
  PublicSiteResponseSchema,
  type AuthSessionResponse,
} from '@yebo/contracts';
import { useEffect, useState } from 'react';
import { SessionView, type SessionState } from '@/components/auth/session-view';
import { AuthRequestError, apiFetch, readCsrfCookie } from '@/lib/auth-client';

async function loadSession(): Promise<AuthSessionResponse> {
  const res = await apiFetch('/api/v1/auth/session');
  return AuthSessionResponseSchema.parse(await res.json());
}

/**
 * Comprueba la sesión de empresa; si el token caducó o cambiaron los permisos, la renueva en silencio una vez.
 * Cerrar sesión cierra la de esta empresa y continúa en el hub para cerrar la de identidad.
 */
export function SessionPanel() {
  const [state, setState] = useState<SessionState>('checking');
  const [company, setCompany] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    apiFetch('/api/v1/public/site')
      .then(async (res) => {
        const parsed = PublicSiteResponseSchema.safeParse(await res.json());
        if (parsed.success) setCompany(parsed.data.tenant.tradeName);
      })
      .catch(() => setCompany(null));
    loadSession()
      .catch(async (e) => {
        if (!(e instanceof AuthRequestError) || e.status !== 401) throw e;
        await apiFetch('/api/v1/auth/refresh', { method: 'POST', csrf: readCsrfCookie() });
        return loadSession();
      })
      .then(() => setState('signed-in'))
      .catch(() => setState('signed-out'));
  }, []);

  async function signOut() {
    setLeaving(true);
    const res = await apiFetch('/api/v1/auth/logout', { method: 'POST', csrf: readCsrfCookie() }).catch(
      () => null,
    );
    const parsed = res ? AuthLogoutResponseSchema.safeParse(await res.json()) : null;
    window.location.assign(parsed?.success ? parsed.data.hubLogoutUrl : '/');
  }

  return <SessionView company={company} state={state} leaving={leaving} onSignOut={signOut} />;
}
