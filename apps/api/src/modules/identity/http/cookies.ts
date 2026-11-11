import type { Request, Response } from 'express';

/**
 * Cookies del flujo de autenticación (identity-and-sessions §2 y §5). Sin dependencias: lectura de la cabecera
 * Cookie y escritura de Set-Cookie con atributos explícitos. Todas son `Secure`; las `__Host-` van además sin
 * `Domain` y con `Path=/` (ligadas al host exacto).
 */
export const COOKIE = {
  /** Access token (JWT) del dominio de la empresa. */
  access: '__Host-yebo_at',
  /** Refresh token opaco; solo viaja a las rutas de autenticación. */
  refresh: '__Secure-yebo_rt',
  /** Token CSRF (double submit): legible por JavaScript, se repite en la cabecera X-CSRF-Token. */
  csrf: '__Host-yebo_csrf',
  /** Petición de autorización en curso (state + code_verifier), firmada; 10 minutos. */
  authRequest: '__Host-yebo_auth',
  /** Sesión de identidad del hub (id firmado). Solo en el host del hub. */
  hub: '__Host-yebo_hub',
} as const;

export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface CookieOptions {
  maxAgeSeconds: number;
  httpOnly: boolean;
  sameSite: 'Lax' | 'Strict';
  path?: string;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function setCookie(res: Response, name: string, value: string, options: CookieOptions): void {
  const path = options.path ?? '/';
  if (name.startsWith('__Host-') && path !== '/')
    throw new Error(`${name}: las cookies __Host- exigen Path=/`);
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    `Path=${path}`,
    'Secure',
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) attributes.push('HttpOnly');
  res.append('Set-Cookie', attributes.join('; '));
}

export function clearCookie(res: Response, name: string, path = '/'): void {
  setCookie(res, name, '', { maxAgeSeconds: 0, httpOnly: true, sameSite: 'Lax', path });
}
