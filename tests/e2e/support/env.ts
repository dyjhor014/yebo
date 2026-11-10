import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Entorno de los E2E (Fase 4.7c): credenciales de apps/api/.env (y del rol de pruebas en .env.test), siempre contra
 * yebo_test y con hosts *.yebo.localhost, que Chromium resuelve a loopback y trata como contexto seguro (las cookies
 * `__Host-`/`Secure` funcionan sin TLS). Puertos propios para no chocar con `pnpm https:up` ni con `pnpm dev`.
 */
export const ROOT = resolve(__dirname, '..', '..', '..');
for (const file of ['apps/api/.env', 'apps/api/.env.test']) {
  const path = resolve(ROOT, file);
  if (existsSync(path)) process.loadEnvFile(path);
}

export const E2E = {
  database: 'yebo_test',
  apiPort: 4200,
  /** Puerto público del panel (proxy de los E2E); next start escucha en el siguiente. */
  platformPort: 3201,
  nextPort: 3202,
  baseDomain: 'yebo.localhost',
  adminHost: 'admin.yebo.localhost',
  hubHost: 'cuentas.yebo.localhost',
  staffEmail: 'e2e@yebo.pe',
  staffName: 'Staff E2E',
  staffPassword: 'E2E-contraseña-larga-2026',
} as const;

export const ADMIN_URL = `http://${E2E.adminHost}:${E2E.platformPort}`;

/** Variables de la API de los E2E: las del entorno ganan a apps/api/.env (load-env-file). */
export const API_ENV = {
  PG_DATABASE: E2E.database,
  API_HOST: '127.0.0.1',
  API_PORT: String(E2E.apiPort),
  TENANT_BASE_DOMAIN: E2E.baseDomain,
  AUTH_HUB_HOST: E2E.hubHost,
  PLATFORM_ADMIN_HOST: E2E.adminHost,
  TRUST_PROXY: 'loopback',
  LOG_LEVEL: 'warn',
};
