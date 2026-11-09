import type { ClsStore } from 'nestjs-cls';
import type { PlatformPrincipal } from '../../modules/platform-admin/platform-auth.service';
import type { ResolvedTenant } from '../../modules/tenancy/tenant-resolver.service';

/** Contexto por request (AsyncLocalStorage vía nestjs-cls). */
export interface RequestContextStore extends ClsStore {
  /** Identificador de traza; coincide con `x-request-id` y con el `reqId` de los logs. */
  traceId?: string;
  /** Tenant resuelto y validado por el backend (Fase 3). Nunca proviene del cliente. */
  tenantId?: string;
  /** Datos del tenant resuelto por el host (TenantHostGuard). */
  tenant?: ResolvedTenant;
  /** Sesión de empresa verificada en este request (AuthenticationGuard, Fase 3.3). */
  principal?: Principal;
  /** Permisos efectivos de la membresía, cargados una sola vez por request (PermissionService). */
  permissions?: ReadonlySet<string>;
  /** Módulos efectivos del tenant, calculados una sola vez por request (EffectiveModulesService, Fase 4.2). */
  modules?: ReadonlySet<string>;
  /** Miembro del staff de YEBO verificado en este request (PlatformGuard, Fase 4.1). Nunca coexiste con `principal`. */
  platformPrincipal?: PlatformPrincipal;
}

/** Quién hace la petición: usuario, membresía y sesión de empresa, todos del tenant del host. */
export interface Principal {
  userId: string;
  membershipId: string;
  sessionId: string;
  /** `exp` del access token (segundos desde la época). */
  accessTokenExpiresAt: number;
}
