'use client';

import { AuthTokenResponseSchema, PublicSiteResponseSchema } from '@yebo/contracts';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { EnteringView, type EnteringState } from '@/components/auth/entering-view';
import { apiFetch } from '@/lib/auth-client';

/**
 * Regreso del hub al dominio de la empresa (identity-and-sessions §3, pasos 10–13). El código se canjea por POST
 * UNA sola vez (la referencia evita el doble envío del modo estricto de React); el `code_verifier` no pasa por el
 * navegador: está en la cookie firmada del propio host.
 */
export function Redeem() {
  const params = useSearchParams();
  const sent = useRef(false);
  const [state, setState] = useState<EnteringState>('entering');
  const [company, setCompany] = useState<string | null>(null);

  useEffect(() => {
    // Nombre de la empresa de este dominio (dato público), para que el usuario sepa a dónde está entrando.
    apiFetch('/api/v1/public/site')
      .then(async (res) => {
        const parsed = PublicSiteResponseSchema.safeParse(await res.json());
        if (parsed.success) setCompany(parsed.data.tenant.tradeName);
      })
      .catch(() => setCompany(null));
  }, []);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const code = params.get('code');
    const state = params.get('state');
    // El código no debe quedar en el historial ni en la barra de direcciones.
    window.history.replaceState(null, '', '/auth/callback');
    if (!code || !state) {
      setState('expired');
      return;
    }
    apiFetch('/api/v1/auth/token', { method: 'POST', body: JSON.stringify({ code, state }) })
      .then(async (res) => {
        const parsed = AuthTokenResponseSchema.safeParse(await res.json());
        window.location.replace(parsed.success ? parsed.data.returnTo : '/');
      })
      .catch(() => setState('expired'));
  }, [params]);

  return <EnteringView company={company} state={state} />;
}
