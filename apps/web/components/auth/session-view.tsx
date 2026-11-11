import { AccessShell } from '../identity/access-shell';
import { Button, ButtonLink } from '../ui/button';
import { AccessHeading } from './heading';

export type SessionState = 'checking' | 'signed-in' | 'signed-out';

/**
 * Estado de la sesión en el dominio de la empresa (página provisional de la Fase 3.2b; el panel real llega en
 * fases posteriores): comprobando, sesión iniciada o sesión finalizada.
 */
export function SessionView({
  company,
  state,
  leaving,
  onSignOut,
}: {
  company: string | null;
  state: SessionState;
  leaving: boolean;
  onSignOut: () => void;
}) {
  return (
    <AccessShell destination={company} route={state === 'signed-out' ? 'ended' : 'ready'}>
      <div aria-live="polite">
        {state === 'checking' && <AccessHeading title="Comprobando tu sesión…" />}
        {state === 'signed-in' && (
          <>
            <AccessHeading title={company ? `Estás en ${company}` : 'Sesión iniciada'}>
              Tu sesión está activa en este navegador.
            </AccessHeading>
            <div className="mt-8">
              <Button variant="secondary" busy={leaving} busyLabel="Cerrando sesión…" onClick={onSignOut}>
                Cerrar sesión
              </Button>
            </div>
          </>
        )}
        {state === 'signed-out' && (
          <>
            <AccessHeading title="Tu sesión terminó">
              Por seguridad, las sesiones se cierran tras un tiempo sin uso o al cerrar sesión. Vuelve a
              entrar para continuar.
            </AccessHeading>
            <div className="mt-8">
              <ButtonLink href="/api/v1/auth/start?return=/panel">Iniciar sesión</ButtonLink>
            </div>
          </>
        )}
      </div>
    </AccessShell>
  );
}
