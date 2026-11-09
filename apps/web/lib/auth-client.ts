'use client';

import { ErrorResponseSchema } from '@yebo/contracts';

/**
 * Cliente mínimo del flujo de autenticación (Fase 3.2b). Todas las llamadas van al MISMO origen
 * (`/api/v1/...`, enrutado a la API por Nginx), así que no hay CORS ni cookies entre dominios.
 */
export class AuthRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Lee el token CSRF (*double submit*) de la cookie del propio host. */
export function readCsrfCookie(): string | undefined {
  const match = document.cookie.split('; ').find((c) => c.startsWith('__Host-yebo_csrf='));
  return match ? decodeURIComponent(match.slice('__Host-yebo_csrf='.length)) : undefined;
}

export async function apiFetch(path: string, init: RequestInit & { csrf?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.csrf) headers.set('X-CSRF-Token', init.csrf);
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) {
    const parsed = ErrorResponseSchema.safeParse(await res.json().catch(() => null));
    throw new AuthRequestError(
      res.status,
      parsed.success ? parsed.data.error.code : 'INTERNAL_ERROR',
      parsed.success ? parsed.data.error.message : 'No se pudo completar la operación',
    );
  }
  return res;
}

/** Obtiene un token CSRF nuevo del host actual (`/api/v1/hub/csrf` o `/api/v1/auth/csrf`). */
export async function fetchCsrf(path: '/api/v1/hub/csrf' | '/api/v1/auth/csrf'): Promise<string> {
  const res = await apiFetch(path);
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}
