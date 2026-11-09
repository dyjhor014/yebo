import type { Request, Response } from 'express';
import { AppError } from '../../../common/errors/app-error';
import { newOpaqueToken, safeEqual } from '../pkce';
import { COOKIE, readCookie, setCookie } from './cookies';

export const CSRF_HEADER = 'x-csrf-token';

/**
 * CSRF *double submit* (identity-and-sessions §5): la cookie `__Host-yebo_csrf` (legible por JavaScript del propio
 * host) debe coincidir con la cabecera X-CSRF-Token. Una web ajena no puede leer la cookie ni, sin CORS, enviar
 * cabeceras propias a esta API. Se exige en todas las mutaciones de autenticación.
 */
export function assertCsrf(req: Request): void {
  const header = req.headers[CSRF_HEADER];
  const fromHeader = Array.isArray(header) ? undefined : header;
  if (!safeEqual(readCookie(req, COOKIE.csrf), fromHeader)) {
    throw new AppError('FORBIDDEN', 'Falta o no coincide el token CSRF', 403);
  }
}

/** Emite (o renueva) el token CSRF del host actual y lo devuelve para que el cliente lo envíe en la cabecera. */
export function issueCsrf(res: Response, maxAgeSeconds: number): string {
  const token = newOpaqueToken();
  setCookie(res, COOKIE.csrf, token, { maxAgeSeconds, httpOnly: false, sameSite: 'Strict' });
  return token;
}
