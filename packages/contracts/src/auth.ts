import { z } from 'zod';

/**
 * Contratos del hub de cuentas y de la sesión de empresa (Fase 3.2b; identity-and-sessions §3–8).
 * Flujo: OAuth 2.0 Authorization Code + PKCE S256, propio de YEBO (ADR-022, decisión del 2026-11-09).
 */

/** GET /api/v1/hub/authorize (host del hub). Parámetros cerrados: no se acepta `redirect_uri` ni otro tipo de respuesta. */
export const HubAuthorizeQuerySchema = z.strictObject({
  response_type: z.literal('code'),
  tenant_host: z.string().min(3).max(253),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal('S256'),
});
export type HubAuthorizeQuery = z.infer<typeof HubAuthorizeQuerySchema>;

/** POST /api/v1/hub/login (host del hub). */
export const HubLoginRequestSchema = z.strictObject({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(1024),
});
export type HubLoginRequest = z.infer<typeof HubLoginRequestSchema>;

/** GET /api/v1/hub/csrf y GET /api/v1/auth/csrf: token de la protección *double submit*. */
export const CsrfResponseSchema = z.object({ csrfToken: z.string() });
export type CsrfResponse = z.infer<typeof CsrfResponseSchema>;

/** GET /api/v1/hub/me/memberships: solo las empresas del propio usuario. */
export const HubMembershipsResponseSchema = z.object({
  memberships: z.array(z.object({ tenantId: z.string(), tradeName: z.string(), host: z.string() })),
});
export type HubMembershipsResponse = z.infer<typeof HubMembershipsResponseSchema>;

/** GET /api/v1/hub/branding?tenant_host=: nombre de la empresa desde la que se inicia el acceso (D3.1). */
export const HubBrandingResponseSchema = z.object({ tradeName: z.string() });
export type HubBrandingResponse = z.infer<typeof HubBrandingResponseSchema>;

/** POST /api/v1/auth/token (dominio de la empresa): canje del código. El `code_verifier` NO viaja: está en la cookie firmada. */
export const AuthTokenRequestSchema = z.strictObject({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type AuthTokenRequest = z.infer<typeof AuthTokenRequestSchema>;

export const AuthTokenResponseSchema = z.object({
  /** Ruta interna (empieza por "/") a la que volver tras iniciar sesión. */
  returnTo: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
});
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;

export const AuthRefreshResponseSchema = z.object({ accessTokenExpiresAt: z.iso.datetime() });
export type AuthRefreshResponse = z.infer<typeof AuthRefreshResponseSchema>;

/** POST /api/v1/auth/logout: tras cerrar la sesión de la empresa, el cliente continúa en el hub para cerrar la de identidad. */
export const AuthLogoutResponseSchema = z.object({ hubLogoutUrl: z.string() });
export type AuthLogoutResponse = z.infer<typeof AuthLogoutResponseSchema>;

/** GET /api/v1/auth/session: sesión de empresa verificada en este request (token + host + PostgreSQL). */
export const AuthSessionResponseSchema = z.object({
  userId: z.string(),
  tenantId: z.string(),
  membershipId: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
  /** Permisos efectivos de la membresía en esta empresa (la autoridad sigue siendo el backend). */
  permissions: z.array(z.string()),
  /** Módulos efectivos de la empresa (multitenancy §6): la interfaz oculta lo no habilitado; la autoridad es el backend. */
  modules: z.array(z.string()),
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;
