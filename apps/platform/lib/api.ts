'use client';

import { ErrorResponseSchema } from '@yebo/contracts';
import type { z } from 'zod';

/**
 * Cliente del panel: todas las llamadas van al MISMO origen (admin.yebo.pe/api/v1/...), con la cookie de sesión
 * del staff (`__Host-yebo_admin`) y el CSRF *double submit* en las mutaciones.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function readCsrfCookie(): string | undefined {
  const match = document.cookie.split('; ').find((c) => c.startsWith('__Host-yebo_csrf='));
  return match ? decodeURIComponent(match.slice('__Host-yebo_csrf='.length)) : undefined;
}

let csrfPromise: Promise<string> | null = null;
async function csrf(): Promise<string> {
  const existing = readCsrfCookie();
  if (existing) return existing;
  csrfPromise ??= fetch('/api/v1/platform/auth/csrf', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => r.json() as Promise<{ csrfToken: string }>)
    .then((b) => b.csrfToken)
    .finally(() => (csrfPromise = null));
  return csrfPromise;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  if (init.body) headers.set('Content-Type', 'application/json');
  if (method !== 'GET') headers.set('X-CSRF-Token', await csrf());
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) {
    const parsed = ErrorResponseSchema.safeParse(await res.json().catch(() => null));
    throw new ApiError(
      res.status,
      parsed.success ? parsed.data.error.code : 'INTERNAL_ERROR',
      parsed.success ? parsed.data.error.message : 'No se pudo completar la operación. Inténtalo de nuevo.',
    );
  }
  return res;
}

/** GET validado con el contrato compartido. */
export async function get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  return schema.parse(await (await call(path)).json());
}

/** POST con cuerpo JSON; valida la respuesta si se da un esquema (204 → undefined). */
export async function post<S extends z.ZodType>(
  path: string,
  body?: unknown,
  schema?: S,
): Promise<S extends z.ZodType ? z.infer<S> : undefined> {
  const res = await call(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!schema || res.status === 204) return undefined as never;
  return schema.parse(await res.json()) as never;
}

/** 401 en cualquier pantalla del panel → al login (la sesión caducó o se cerró). */
export function isUnauthenticated(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}
