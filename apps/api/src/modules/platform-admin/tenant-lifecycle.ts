import type { SubscriptionStatus, TenantStatus } from '../../generated/prisma/client';

/**
 * Máquina de estados del tenant (multitenancy §5.2, ADR-023; Fase 4.3a). Fuente única de las transiciones: la usan
 * el panel (cambios manuales del staff) y el job de estados (automáticas). Ningún estado borra datos.
 *
 * Manuales (con motivo y auditadas):
 * - TRIAL → ACTIVE (conversión), EXPIRED o CANCELLED.
 * - ACTIVE → PAST_DUE (factura vencida; desde la 4.5 también la marca el cobro) o CANCELLED.
 * - PAST_DUE → ACTIVE (pago regularizado), SUSPENDED (antes de que venza la gracia) o CANCELLED.
 * - SUSPENDED / EXPIRED → ACTIVE (reactivación inmediata al registrarse el pago) o CANCELLED.
 * - CANCELLED es final: el periodo de cierre se deriva de `cancelled_at` (tenant-operation.ts).
 */
export const MANUAL_TRANSITIONS: Readonly<Record<TenantStatus, readonly TenantStatus[]>> = {
  TRIAL: ['ACTIVE', 'EXPIRED', 'CANCELLED'],
  ACTIVE: ['PAST_DUE', 'CANCELLED'],
  PAST_DUE: ['ACTIVE', 'SUSPENDED', 'CANCELLED'],
  SUSPENDED: ['ACTIVE', 'CANCELLED'],
  EXPIRED: ['ACTIVE', 'CANCELLED'],
  CANCELLED: [],
};

export function isManualTransitionAllowed(from: TenantStatus, to: TenantStatus): boolean {
  return MANUAL_TRANSITIONS[from].includes(to);
}

/** Estado de la suscripción vigente que acompaña a cada estado del tenant. */
export const SUBSCRIPTION_STATUS_FOR: Readonly<Record<TenantStatus, SubscriptionStatus>> = {
  TRIAL: 'TRIALING',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
};

/** Días de gracia en PAST_DUE si el plan no los define (aprobado el 2026-11-05). */
export const DEFAULT_PAST_DUE_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface LifecycleCandidate {
  status: TenantStatus;
  statusChangedAt: Date;
  trialEndsAt: Date | null;
  /** De la política de la versión de plan vigente; `null` = valor por defecto. */
  pastDueGraceDays: number | null;
}

/**
 * Transición AUTOMÁTICA que corresponde en `now`, o `null`. Pura e idempotente: el job puede ejecutarse tarde, dos
 * veces o en paralelo sin cambiar el resultado.
 * - TRIAL → EXPIRED al llegar `trial_ends_at` (un trial sin fecha no vence solo: lo decide el staff).
 * - PAST_DUE → SUSPENDED tras los días de gracia contados desde la entrada en PAST_DUE.
 */
export function dueTransition(c: LifecycleCandidate, now: Date): TenantStatus | null {
  if (c.status === 'TRIAL' && c.trialEndsAt && c.trialEndsAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (c.status === 'PAST_DUE') {
    const grace = c.pastDueGraceDays ?? DEFAULT_PAST_DUE_GRACE_DAYS;
    if (c.statusChangedAt.getTime() + grace * DAY_MS <= now.getTime()) return 'SUSPENDED';
  }
  return null;
}

export const AUTOMATIC_REASON: Readonly<Partial<Record<TenantStatus, string>>> = {
  EXPIRED: 'Fin del periodo de prueba sin activación',
  SUSPENDED: 'Fin de los días de gracia sin regularizar el pago',
};
