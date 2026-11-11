/**
 * Cookies del panel de administración (host PLATFORM_ADMIN_HOST). `__Host-`: ligadas al host exacto, `Secure`, sin
 * `Domain` y con `Path=/`. Nunca coinciden con las del hub ni con las de las empresas. El CSRF reutiliza
 * `__Host-yebo_csrf`, que por ser `__Host-` es distinta en cada host.
 */
export const PLATFORM_COOKIE = {
  /** Token opaco de la sesión del staff. */
  session: '__Host-yebo_admin',
  /** Login pendiente del segundo factor (id firmado + caducidad), 5 minutos. */
  pendingMfa: '__Host-yebo_admin_mfa',
} as const;

export const PENDING_MFA_PURPOSE = 'platform-mfa';
export const PENDING_MFA_TTL_SECONDS = 300;
