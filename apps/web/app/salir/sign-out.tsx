'use client';

import { useCallback, useEffect, useState } from 'react';
import { SignOutView, type SignOutState } from '@/components/auth/sign-out-view';
import { apiFetch, fetchCsrf } from '@/lib/auth-client';

/** Cierre de la sesión de identidad en el hub: cierra todas las empresas de este navegador (identity-and-sessions §8). */
export function SignOut() {
  const [state, setState] = useState<SignOutState>('pending');

  const signOut = useCallback(() => {
    setState('pending');
    fetchCsrf('/api/v1/hub/csrf')
      .then((csrf) => apiFetch('/api/v1/hub/logout', { method: 'POST', csrf }))
      .then(() => setState('done'))
      .catch(() => setState('error'));
  }, []);

  useEffect(() => signOut(), [signOut]);

  return <SignOutView state={state} onRetry={signOut} />;
}
