/**
 * LISTA BLANCA de rutas públicas (sin sesión de empresa). Diseño de la 3.3 aceptado el 2026-11-09: toda ruta con
 * `@Public(...)` debe figurar aquí, y la prueba de barrido falla si sobra o falta alguna. Añadir una ruta pública
 * obliga a cambiar este archivo, lo que se ve en la revisión.
 *
 * Que una ruta sea "pública" solo significa que no exige el access token de empresa: las del hub y las del flujo
 * de entrada se autentican con otras credenciales (cookie del hub, cookie firmada del flujo, código de
 * autorización, refresh token, CSRF), como define identity-and-sessions.
 */
export const PUBLIC_ROUTES: readonly string[] = [
  // Salud del proceso (sin host de empresa).
  'GET /api/v1/health/live',
  'GET /api/v1/health/ready',
  // Identidad pública de la empresa del host.
  'GET /api/v1/public/site',
  // Hub de cuentas (solo en AUTH_HUB_HOST; sesión de identidad propia).
  'GET /api/v1/hub/csrf',
  'GET /api/v1/hub/authorize',
  'POST /api/v1/hub/login',
  'POST /api/v1/hub/logout',
  'GET /api/v1/hub/me/memberships',
  'GET /api/v1/hub/branding',
  // Entrada a la empresa (host del tenant; OAuth 2.0 + PKCE y renovación).
  'GET /api/v1/auth/start',
  'POST /api/v1/auth/token',
  'GET /api/v1/auth/csrf',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
];
