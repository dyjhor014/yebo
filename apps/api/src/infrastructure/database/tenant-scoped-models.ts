/**
 * Registro de modelos Prisma con columna tenant_id (multitenancy §3–4).
 *
 * - TENANT_SCOPED_MODELS: tablas de tenant. Pasan por las dos barreras: filtro de la extensión Prisma
 *   y RLS forzado. Una prueba unitaria verifica que todo modelo con `tenantId` del esquema esté aquí
 *   (o en la lista de excepciones), y las pruebas de integración verifican RLS en sus tablas.
 * - GLOBAL_MODELS_WITH_TENANT_ID: excepciones explícitas. Tablas globales (multitenancy §4.3) que
 *   referencian a un tenant pero deben leerse SIN contexto de tenant. Sin RLS de tenant y sin acceso
 *   para yebo_app; solo las usa la plataforma (yebo_platform).
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set<string>([
  'TenantMembership',
  'Role',
  'RolePermission',
  'MembershipRole',
]);

/**
 * - tenant_domains: el resolver la consulta para DESCUBRIR el tenant a partir del host (ADR-004).
 * - tenant_sessions: se consulta para validar el token ANTES de abrir el contexto de tenant (ADR-009);
 *   la gestiona identidad con yebo_identity (Fase 3.2).
 * - authorization_codes: se canjea antes de que exista la sesión de empresa (Fase 3.2b); solo yebo_identity.
 * - platform_audit_logs: auditoría del staff de YEBO (Fase 4.1); `tenant_id` indica la empresa afectada. Solo
 *   yebo_backoffice, que no tiene contexto de tenant.
 */
export const GLOBAL_MODELS_WITH_TENANT_ID: ReadonlySet<string> = new Set<string>([
  'TenantDomain',
  'TenantSession',
  'AuthorizationCode',
  'PlatformAuditLog',
]);

/** Nombres de tabla equivalentes, para las verificaciones sobre el catálogo de PostgreSQL. */
export const GLOBAL_TABLES_WITH_TENANT_ID: readonly string[] = [
  'tenant_domains',
  'tenant_sessions',
  'authorization_codes',
  'platform_audit_logs',
];
