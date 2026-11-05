import type { ClsStore } from 'nestjs-cls';

/** Contexto por request (AsyncLocalStorage vía nestjs-cls). */
export interface RequestContextStore extends ClsStore {
  /** Identificador de traza; coincide con `x-request-id` y con el `reqId` de los logs. */
  traceId?: string;
  /** Tenant resuelto y validado por el backend (Fase 3). Nunca proviene del cliente. */
  tenantId?: string;
}
