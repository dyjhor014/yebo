import type { ReactNode } from 'react';
import { RouteLine, type RouteState } from './route-line';
import { Logo, Slogan } from './logo';

/**
 * Estructura de todas las pantallas de acceso: carril navy de identidad + superficie de trabajo
 * (clara, u oscura con un filo slate que la separa del carril).
 * Escritorio: carril lateral fijo. Móvil: banda superior compacta; el contenido empieza arriba, sin centrar en
 * vertical, para que el teclado no lo empuje fuera de la pantalla.
 */
export function AccessShell({
  destination = null,
  route = 'ready',
  children,
}: {
  destination?: string | null;
  route?: RouteState;
  children: ReactNode;
}) {
  return (
    <div className="yebo-access min-h-dvh lg:grid lg:grid-cols-[minmax(20rem,26rem)_1fr]">
      <aside className="yebo-rail border-b border-rail-edge bg-rail text-on-rail lg:flex lg:border-r lg:border-b-0 lg:min-h-dvh lg:flex-col lg:justify-between lg:px-12 lg:py-12">
        <div className="flex flex-col gap-5 px-5 py-5 sm:px-8 lg:gap-16 lg:p-0">
          <Logo className="text-2xl lg:text-[1.75rem]" />
          <RouteLine destination={destination} state={route} />
        </div>
        <Slogan className="hidden text-sm lg:block" />
      </aside>
      <main className="px-5 pt-10 pb-16 sm:px-8 lg:flex lg:items-center lg:px-16 lg:py-16">
        <div className="mx-auto w-full max-w-[24rem] lg:mx-0">{children}</div>
      </main>
    </div>
  );
}
