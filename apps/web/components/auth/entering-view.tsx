import { AccessShell } from '../identity/access-shell';
import { ButtonLink } from '../ui/button';
import { AccessHeading } from './heading';

export type EnteringState = 'entering' | 'expired';

/**
 * Regreso desde el hub al dominio de la empresa. Mientras se completa el acceso, el trayecto avanza; si el enlace
 * caducó o ya se usó, se ofrece volver a empezar. Sin detalles técnicos del flujo.
 */
export function EnteringView({ company, state }: { company: string | null; state: EnteringState }) {
  return (
    <AccessShell destination={company} route={state === 'entering' ? 'travelling' : 'ready'}>
      <div aria-live="polite">
        {state === 'entering' ? (
          <AccessHeading title={company ? `Entrando a ${company}…` : 'Entrando…'}>
            Estamos preparando tu sesión.
          </AccessHeading>
        ) : (
          <>
            <AccessHeading title="Este acceso ya no es válido">
              El enlace caducó o ya se usó. Vuelve a intentarlo para entrar{company ? ` a ${company}` : ''}.
            </AccessHeading>
            <div className="mt-8">
              <ButtonLink href="/api/v1/auth/start">Volver a intentar</ButtonLink>
            </div>
          </>
        )}
      </div>
    </AccessShell>
  );
}
