import { AccessShell } from '../identity/access-shell';
import { Button, ButtonLink } from '../ui/button';
import { Notice } from '../ui/notice';
import { AccessHeading } from './heading';

export type SignOutState = 'pending' | 'done' | 'error';

/** Cierre de la sesión en el hub: cierra todas las empresas de este navegador. */
export function SignOutView({ state, onRetry }: { state: SignOutState; onRetry: () => void }) {
  return (
    <AccessShell route="ended">
      <div aria-live="polite">
        {state === 'pending' && <AccessHeading title="Cerrando sesión…" />}
        {state === 'done' && (
          <>
            <AccessHeading title="Sesión cerrada">
              Cerraste la sesión en todas las empresas de este navegador. Tus otros dispositivos siguen
              conectados.
            </AccessHeading>
            <div className="mt-8">
              <ButtonLink href="/login">Volver a iniciar sesión</ButtonLink>
            </div>
          </>
        )}
        {state === 'error' && (
          <>
            <AccessHeading title="No pudimos cerrar la sesión" />
            <div className="mt-8 flex flex-col gap-5">
              <Notice>
                Revisa tu conexión e inténtalo de nuevo. Mientras tanto, tu sesión sigue abierta.
              </Notice>
              <Button onClick={onRetry}>Intentar de nuevo</Button>
            </div>
          </>
        )}
      </div>
    </AccessShell>
  );
}
