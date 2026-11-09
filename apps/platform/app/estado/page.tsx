import { getApiStatus } from '@/lib/api-status';

export const dynamic = 'force-dynamic';

/* Página de estado de la Fase 2: se conserva tal cual en /estado (la raíz pasa al panel en la Fase 4.7). */

const LABELS: Record<string, string> = {
  databaseApp: 'PostgreSQL (rol de aplicación)',
  databasePlatform: 'PostgreSQL (rol de plataforma)',
  redis: 'Redis',
};

export default async function StatusPage() {
  const status = await getApiStatus();
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-2xl font-semibold">YEBO · Plataforma</h1>
      <p className="mt-1 text-sm opacity-70">Panel superadministrador SaaS · estado del sistema (Fase 2)</p>
      <section className="mt-8 rounded-lg border border-current/15 p-4" aria-live="polite">
        {status.reachable ? (
          <>
            <p className="font-medium">
              API {status.health.status === 'ok' ? 'operativa' : 'con dependencias caídas'} · v
              {status.health.version}
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {Object.entries(status.health.checks).map(([name, check]) => (
                <li key={name} className="flex justify-between gap-4">
                  <span>{LABELS[name] ?? name}</span>
                  <span className={check.status === 'up' ? 'text-emerald-600' : 'text-red-600'}>
                    {check.status === 'up' ? `activo · ${check.latencyMs ?? '?'} ms` : 'caído'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-red-600">No se pudo consultar la API: {status.reason}</p>
        )}
      </section>
    </main>
  );
}
