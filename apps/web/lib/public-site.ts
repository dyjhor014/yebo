import 'server-only';
import { PublicSiteResponseSchema, type PublicSiteResponse } from '@yebo/contracts';
import { headers } from 'next/headers';
import { cache } from 'react';

/**
 * Sitio público de la empresa del host (Fase 5.3), leído en el SERVIDOR de Next con el host original reenviado a la
 * API (ADR-004: el tenant sale del host, nunca de la URL ni del cliente). Una sola petición por render (cache()).
 */
export type HostKind = { kind: 'tenant'; site: PublicSiteResponse } | { kind: 'hub' } | { kind: 'unknown' };

async function requestHost(): Promise<{ host: string; proto: string }> {
  const h = await headers();
  return {
    host: h.get('x-forwarded-host') ?? h.get('host') ?? '',
    proto: h.get('x-forwarded-proto') ?? 'http',
  };
}

async function api(path: string, host: string, proto: string): Promise<Response | null> {
  const base = process.env.API_INTERNAL_URL;
  if (!base || !host) return null;
  try {
    return await fetch(`${base}${path}`, {
      headers: { 'X-Forwarded-Host': host, 'X-Forwarded-Proto': proto },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return null;
  }
}

export const resolveHost = cache(async (): Promise<HostKind> => {
  const { host, proto } = await requestHost();
  const res = await api('/api/v1/public/site', host, proto);
  if (res?.ok) {
    const parsed = PublicSiteResponseSchema.safeParse(await res.json());
    if (parsed.success) return { kind: 'tenant', site: parsed.data };
  }
  if (res?.status === 404) {
    // El hub de cuentas no es una empresa: su raíz lleva al login.
    const hub = await api('/api/v1/hub/csrf', host, proto);
    if (hub?.ok) return { kind: 'hub' };
    return { kind: 'unknown' };
  }
  // API caída o respuesta inesperada: que el error lo muestre Next (no un 404 engañoso).
  throw new Error(`No se pudo leer el sitio del host (${res?.status ?? 'sin respuesta'})`);
});
