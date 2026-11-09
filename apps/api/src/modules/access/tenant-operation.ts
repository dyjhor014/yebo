import type { ResolvedTenant } from '../tenancy/tenant-resolver.service';

/** Categorías de operación (multitenancy §5.1, ADR-023). Cada endpoint de negocio lleva exactamente una. */
export const TENANT_OPERATION_CATEGORIES = [
  'NEW_COMMERCIAL',
  'FULFILL',
  'AFTER_SALES',
  'CASH',
  'READ',
  'EXPORT',
  'CONFIGURE',
  'CONFIGURE_COMPLIANCE',
  'USERS_REDUCE',
  'USERS_ADD',
  'BILLING_SELF',
] as const;
export type TenantOperationCategory = (typeof TENANT_OPERATION_CATEGORIES)[number];

/**
 * Fase del tenant para la matriz. `CANCELLED` se divide en el periodo de cierre (30 días desde `cancelled_at`,
 * aprobado el 2026-11-05) y lo que viene después.
 */
export type TenantPhase =
  'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'EXPIRED' | 'CANCELLED_CLOSING' | 'CANCELLED_CLOSED';

export const CANCELLED_CLOSING_DAYS = 30;

/** Columnas de la matriz que permiten la operación. */
const ALL_BUT_CLOSED: readonly TenantPhase[] = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'EXPIRED',
  'CANCELLED_CLOSING',
];
const OPERATIVE_ONLY: readonly TenantPhase[] = ['TRIAL', 'ACTIVE', 'PAST_DUE'];

/**
 * Matriz por defecto (multitenancy §5.2). Es el valor por defecto de `plan_versions.suspension_policy`, que
 * llega con los planes en la Fase 4; hasta entonces es la única política. Los tenants no pueden cambiarla.
 * - `EXPORT` tras el cierre: solo vía soporte de YEBO (Fase 4), así que aquí se deniega al tenant.
 * - Los límites del trial y el aviso de `PAST_DUE` se aplican en los servicios y en el frontend (Fase 4).
 */
export const DEFAULT_TENANT_OPERATION_MATRIX: Readonly<
  Record<TenantOperationCategory, readonly TenantPhase[]>
> = {
  NEW_COMMERCIAL: OPERATIVE_ONLY,
  FULFILL: ALL_BUT_CLOSED,
  AFTER_SALES: ALL_BUT_CLOSED,
  CASH: ALL_BUT_CLOSED,
  READ: ALL_BUT_CLOSED,
  EXPORT: ALL_BUT_CLOSED,
  CONFIGURE: OPERATIVE_ONLY,
  CONFIGURE_COMPLIANCE: ALL_BUT_CLOSED,
  USERS_REDUCE: ALL_BUT_CLOSED,
  USERS_ADD: OPERATIVE_ONLY,
  BILLING_SELF: ALL_BUT_CLOSED,
};

/** Fases en las que se puede iniciar sesión en la empresa (fila «Login» de la matriz). */
const LOGIN_PHASES: readonly TenantPhase[] = ALL_BUT_CLOSED;

export function tenantPhase(tenant: Pick<ResolvedTenant, 'status' | 'cancelledAt'>, now: Date): TenantPhase {
  if (tenant.status !== 'CANCELLED') return tenant.status;
  // Sin fecha de cancelación no hay periodo de cierre que conceder: se trata como cerrado (falla cerrado).
  if (!tenant.cancelledAt) return 'CANCELLED_CLOSED';
  const closingEnds = new Date(tenant.cancelledAt).getTime() + CANCELLED_CLOSING_DAYS * 86_400_000;
  return now.getTime() < closingEnds ? 'CANCELLED_CLOSING' : 'CANCELLED_CLOSED';
}

export function isOperationAllowed(category: TenantOperationCategory, phase: TenantPhase): boolean {
  return DEFAULT_TENANT_OPERATION_MATRIX[category].includes(phase);
}

export function isLoginAllowed(phase: TenantPhase): boolean {
  return LOGIN_PHASES.includes(phase);
}
