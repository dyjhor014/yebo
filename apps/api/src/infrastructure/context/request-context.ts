import type { ClsStore } from 'nestjs-cls';
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
}

/** Quién hace la petición: usuario, membresía y sesión de empresa, todos del tenant del host. */
export interface Principal {
  userId: string;
  membershipId: string;
  sessionId: string;
  /** `exp` del access token (segundos desde la época). */
  accessTokenExpiresAt: number;
}
