/**
 * Catálogo global de permisos (security.md §2) y plantillas de roles de la plataforma.
 *
 * FUENTE ÚNICA en código. La migración `20261110120000_fase3_3_access` siembra exactamente estos valores y
 * una prueba de integración compara la base con este archivo. Fase 3.3 (decisión del 2026-11-10): solo los
 * permisos de lo que existe (gestión de accesos) y la plantilla Administrador. Cada fase añade sus permisos
 * y completa las plantillas (Cajero, Almacenero, Embarque, Contador...) con su propia migración.
 */
export const PERMISSION_CATALOG = {
  'members.read': { module: 'ACCESS', sensitive: false, description: 'Ver los miembros de la empresa' },
  'members.suspend': { module: 'ACCESS', sensitive: true, description: 'Suspender el acceso de un miembro' },
  'members.reactivate': {
    module: 'ACCESS',
    sensitive: true,
    description: 'Reactivar el acceso de un miembro',
  },
  'members.sessions.revoke': {
    module: 'ACCESS',
    sensitive: true,
    description: 'Cerrar las sesiones de un miembro en esta empresa',
  },
  'roles.read': { module: 'ACCESS', sensitive: false, description: 'Ver los roles de la empresa' },
  'roles.assign': { module: 'ACCESS', sensitive: true, description: 'Asignar roles a los miembros' },
  // Fase 4.3b: invitar es USERS_ADD (aumenta el consumo facturable).
  'members.invite': { module: 'ACCESS', sensitive: true, description: 'Invitar personas a la empresa' },
  // Fase 4.5: «Obligaciones con YEBO» (BILLING_SELF).
  'billing.read': {
    module: 'ACCESS',
    sensitive: false,
    description: 'Ver las obligaciones de la empresa con YEBO',
  },
  // Fase 4.6: accesos de soporte de YEBO (ver, aprobar, revocar y exigir aprobación).
  'support.read': {
    module: 'ACCESS',
    sensitive: false,
    description: 'Ver los accesos de soporte de YEBO y su registro',
  },
  'support.manage': {
    module: 'ACCESS',
    sensitive: true,
    description: 'Aprobar o revocar accesos de soporte de YEBO',
  },
  // Fase 5.1: sitio público (white label). Editar no exige el módulo WHITE_LABEL; sin él se publica lo básico (F5-Q4).
  'site.manage': {
    module: 'SITE',
    sensitive: true,
    description: 'Editar y publicar el sitio público de la empresa',
  },
} as const satisfies Record<string, { module: string; sensitive: boolean; description: string }>;

export type PermissionCode = keyof typeof PERMISSION_CATALOG;

export const PERMISSION_CODES = Object.keys(PERMISSION_CATALOG) as PermissionCode[];

export const ROLE_TEMPLATES = {
  ADMIN: { name: 'Administrador', permissions: PERMISSION_CODES },
} as const satisfies Record<string, { name: string; permissions: readonly PermissionCode[] }>;
