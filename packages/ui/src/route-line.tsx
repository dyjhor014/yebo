/**
 * Gesto propio de las pantallas de acceso (identidad YEBO v1.0, «Movemos conexiones»): el acceso como un trayecto
 * entre Cuentas YEBO (origen) y la empresa a la que se entra (destino). Solo vive en el carril navy y su estado
 * es información real: hacia dónde vas, si estás llegando, si no tienes acceso o si cerraste la sesión.
 */
export type RouteState = 'ready' | 'travelling' | 'blocked' | 'ended';

const LABEL: Record<RouteState, string | null> = {
  ready: null,
  travelling: 'Entrando',
  blocked: 'Sin acceso',
  ended: 'Sin sesión activa',
};

export function RouteLine({ destination, state }: { destination: string | null; state: RouteState }) {
  const hasDestination = destination !== null && state !== 'ended';
  const status = LABEL[state];
  return (
    <div className="flex flex-col gap-1.5 text-sm" aria-hidden="true">
      <div className="flex items-center gap-3">
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <span className="size-2.5 rounded-full bg-rail-accent" />
          <span className="font-medium text-on-rail">Cuentas YEBO</span>
        </span>
        {hasDestination && (
          <>
            <span className="relative h-px min-w-8 flex-1 overflow-hidden bg-rail-track">
              {state === 'travelling' && (
                <span className="absolute inset-y-0 left-0 w-1/3 animate-[yebo-travel_1.4s_var(--ease-out-expo)_infinite] bg-rail-accent" />
              )}
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={
                  state === 'blocked'
                    ? 'size-2.5 shrink-0 rounded-full border border-on-rail-muted'
                    : 'size-2.5 shrink-0 rounded-full bg-rail-highlight'
                }
              />
              <span
                className={`truncate font-medium ${state === 'blocked' ? 'text-on-rail-muted' : 'text-on-rail'}`}
              >
                {destination}
              </span>
            </span>
          </>
        )}
      </div>
      {status && state !== 'travelling' && <span className="pl-[1.125rem] text-on-rail-muted">{status}</span>}
    </div>
  );
}
