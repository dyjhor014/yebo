import type { IncomingMessage } from 'node:http';
import type { Options } from 'pino-http';
import type { Env } from '../../config/env';

/**
 * Rutas que nunca deben aparecer en logs (security §4, shipments §1.3).
 * Los cuerpos de request no se registran; aun así se redactan por defensa en profundidad.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.pin',
  '*.pinHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.secret',
  '*.credentials',
  '*.*.pin',
  '*.*.password',
];

export function buildPinoHttpOptions(env: Env): Options {
  return {
    level: env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    genReqId: (req: IncomingMessage) => (req as IncomingMessage & { id?: string }).id ?? 'unknown',
    customLogLevel: (_req, res, err) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    autoLogging: { ignore: (req) => (req.url ?? '').includes('/health/live') },
    base: { service: 'yebo', version: env.APP_VERSION },
    ...(env.LOG_PRETTY && { transport: { target: 'pino-pretty', options: { singleLine: true } } }),
  };
}
