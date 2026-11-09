import { AccessShell } from '../identity/access-shell';
import { Button, ButtonLink } from '../ui/button';
import { Icon } from '../ui/icon';
import { Notice } from '../ui/notice';
import { AccessHeading } from './heading';

export interface Company {
  tenantId: string;
  tradeName: string;
  host: string;
}

export type CompaniesState =
  { kind: 'loading' } | { kind: 'signed-out' } | { kind: 'error' } | { kind: 'ready'; companies: Company[] };

/**
 * Selección de empresa. Con `blocked`, el usuario intentó entrar a una empresa en la que no tiene acceso: se le
 * dice sin revelar nada de esa empresa ni de otros usuarios, y se le ofrecen SUS empresas.
 */
export function CompaniesView({
  blocked,
  blockedCompany,
  state,
  onRetry,
}: {
  blocked: boolean;
  /** Nombre comercial de la empresa solicitada (dato público), si se conoce. */
  blockedCompany: string | null;
  state: CompaniesState;
  onRetry: () => void;
}) {
  const title = blocked
    ? blockedCompany
      ? `No tienes acceso a ${blockedCompany}`
      : 'No tienes acceso a esta empresa'
    : 'Elige una empresa';
  const ready = state.kind === 'ready';
  return (
    <AccessShell
      route={blocked ? 'blocked' : 'ready'}
      destination={blocked ? (blockedCompany ?? 'Empresa solicitada') : null}
    >
      <AccessHeading title={title}>
        {blocked &&
          ready &&
          state.companies.length > 0 &&
          'Si necesitas entrar, pide acceso a quien administra esa empresa. Mientras tanto, puedes entrar a cualquiera de estas.'}
        {blocked &&
          ready &&
          state.companies.length === 0 &&
          'Si necesitas entrar, pide acceso a quien administra esa empresa.'}
        {!blocked && ready && state.companies.length > 0 && 'Tu cuenta YEBO tiene acceso a estas empresas.'}
      </AccessHeading>

      <div className="mt-8" aria-live="polite" aria-busy={state.kind === 'loading' || undefined}>
        {state.kind === 'loading' && (
          <ul className="flex flex-col gap-2" aria-label="Cargando tus empresas">
            {[0, 1, 2].map((i) => (
              <li key={i} className="h-14 animate-pulse rounded-[var(--radius-control)] bg-ink/5" />
            ))}
          </ul>
        )}

        {state.kind === 'signed-out' && (
          <div className="flex flex-col gap-5">
            <p className="text-base leading-6 text-ink-muted">
              Tu sesión terminó. Vuelve a iniciar sesión para ver tus empresas.
            </p>
            <ButtonLink href="/login">Iniciar sesión</ButtonLink>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="flex flex-col gap-5">
            <Notice>No pudimos cargar tus empresas. Revisa tu conexión e inténtalo de nuevo.</Notice>
            <Button variant="secondary" onClick={onRetry}>
              Intentar de nuevo
            </Button>
          </div>
        )}

        {ready && state.companies.length === 0 && (
          <p className="text-base leading-6 text-ink-muted">
            Tu cuenta todavía no tiene acceso a ninguna empresa. Pide a quien administra tu empresa que te
            invite.
          </p>
        )}

        {ready && state.companies.length > 0 && (
          <ul className="flex flex-col divide-y divide-divider border-y border-divider">
            {state.companies.map((company) => (
              <li key={company.tenantId}>
                <a
                  href={`https://${company.host}/api/v1/auth/start`}
                  className="group flex min-h-14 items-center justify-between gap-4 px-1 py-3 text-ink hover:bg-ink/[0.03]"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium break-words">{company.tradeName}</span>
                    <span className="truncate text-sm text-ink-muted">{company.host}</span>
                  </span>
                  <Icon
                    name="arrowRight"
                    className="size-5 shrink-0 text-ink-muted transition-transform duration-[var(--motion-quick)] group-hover:translate-x-0.5 group-hover:text-ink"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(ready || state.kind === 'error') && (
        <p className="mt-10 text-sm">
          <a
            href="/salir"
            className="font-medium text-ink underline decoration-action decoration-2 underline-offset-4 hover:decoration-ink"
          >
            Cerrar sesión
          </a>
        </p>
      )}
    </AccessShell>
  );
}
