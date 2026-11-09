import type { TenantOverview, TenantStatus } from '@yebo/contracts';

/** Etiquetas de estado del panel: siempre texto (el color solo acompaña). */
export const STATUS_LABEL: Record<TenantStatus, string> = {
  TRIAL: 'En prueba',
  ACTIVE: 'Al día',
  PAST_DUE: 'Pago vencido',
  SUSPENDED: 'Suspendida',
  CANCELLED: 'Cancelada',
  EXPIRED: 'Prueba vencida',
};

export type StatusTone = 'ok' | 'warning' | 'danger' | 'neutral';
export const STATUS_TONE: Record<TenantStatus, StatusTone> = {
  TRIAL: 'neutral',
  ACTIVE: 'ok',
  PAST_DUE: 'warning',
  SUSPENDED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'danger',
};

export const MODALITY_LABEL = { LAND: 'terrestre', RIVER: 'fluvial' } as const;
export const SERVICE_LABEL = {
  PASSENGER: 'pasajeros',
  PARCEL: 'encomiendas',
  CARGO: 'carga',
  VEHICLE_TRANSPORT: 'vehículos',
} as const;

const MILESTONE_LABEL: Record<NonNullable<TenantOverview['milestone']>['kind'], string> = {
  SUSPENDED_SINCE: 'Suspendida desde el',
  SUSPENDS_ON: 'Se suspende el',
  TRIAL_ENDS: 'Fin de la prueba:',
  EXPIRED_SINCE: 'Prueba vencida el',
  CLOSING_ENDS: 'Cierre definitivo:',
  PERIOD_ENDS: 'Cierra período el',
};
export const milestoneLabel = (kind: keyof typeof MILESTONE_LABEL) => MILESTONE_LABEL[kind];

/** «Terrestre y fluvial · pasajeros y carga». */
export function operationLine(t: Pick<TenantOverview, 'modalities' | 'services'>): string {
  const join = (xs: string[]) =>
    xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
  const modalities = join(t.modalities.map((m) => MODALITY_LABEL[m]));
  const services = join(t.services.map((s) => SERVICE_LABEL[s]));
  const line = [modalities, services].filter(Boolean).join(' · ');
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : 'Sin servicios configurados';
}

/**
 * Orden por urgencia (crítica de Impeccable): primero lo que pide acción. Suspendidas, luego pago vencido (antes
 * la que se suspende primero), luego pruebas que vencen, y al final el resto por nombre.
 */
const RANK: Record<TenantStatus, number> = {
  SUSPENDED: 0,
  PAST_DUE: 1,
  EXPIRED: 2,
  TRIAL: 3,
  ACTIVE: 4,
  CANCELLED: 5,
};
export function byUrgency(a: TenantOverview, b: TenantOverview): number {
  return (
    RANK[a.status] - RANK[b.status] ||
    (a.milestone?.date ?? '9999').localeCompare(b.milestone?.date ?? '9999') ||
    a.tradeName.localeCompare(b.tradeName, 'es')
  );
}

export type Filter = 'all' | 'attention' | 'trial' | 'over-limit';
export function matches(t: TenantOverview, f: Filter): boolean {
  switch (f) {
    case 'attention':
      return t.status === 'PAST_DUE' || t.status === 'SUSPENDED';
    case 'trial':
      return t.status === 'TRIAL';
    case 'over-limit':
      return extraUsers(t) > 0;
    default:
      return true;
  }
}

export function extraUsers(t: Pick<TenantOverview, 'usersPeak' | 'includedUsers'>): number {
  return t.usersPeak !== null && t.includedUsers !== null ? Math.max(0, t.usersPeak - t.includedUsers) : 0;
}
