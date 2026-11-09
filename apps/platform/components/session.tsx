'use client';

import { PlatformSessionResponseSchema, type PlatformSessionResponse } from '@yebo/contracts';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, isUnauthenticated } from '@/lib/api';

const SessionContext = createContext<PlatformSessionResponse | null>(null);

/** Sesión del staff para las pantallas del panel; sin sesión válida, al login (volviendo luego aquí). */
export function SessionGate({ children }: { children: (s: PlatformSessionResponse) => ReactNode }) {
  const [session, setSession] = useState<PlatformSessionResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    get('/api/v1/platform/auth/session', PlatformSessionResponseSchema)
      .then(setSession)
      .catch((e) => {
        if (isUnauthenticated(e)) router.replace(`/login?volver=${encodeURIComponent(path)}`);
        else setFailed(true);
      });
  }, [router, path]);
  if (failed) {
    return (
      <p role="alert" className="p-8 text-ink">
        No se pudo comprobar la sesión. Recarga la página.
      </p>
    );
  }
  if (!session)
    return (
      <p className="sr-only" role="status">
        Comprobando la sesión…
      </p>
    );
  return <SessionContext.Provider value={session}>{children(session)}</SessionContext.Provider>;
}

export function useSession(): PlatformSessionResponse {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession fuera de SessionGate');
  return s;
}

export function can(s: PlatformSessionResponse, permission: string): boolean {
  return s.permissions.includes(permission);
}
