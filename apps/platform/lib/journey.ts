import type { TenantStatus } from '@yebo/contracts';
import { addDays, date, today } from './format';

/**
 * Trayecto de la empresa (maqueta 4.7 v2, como RouteLine): En prueba → Al día → Pago vencido → Suspendida, con la
 * parada actual y la siguiente. Expirada y Cancelada sustituyen a la última parada cuando son el estado actual.
 */
export type Stop = {
  status: TenantStatus;
  label: string;
  state: 'done' | 'current' | 'pending';
  note: string;
};

const LABEL: Record<TenantStatus, string> = {
  TRIAL: 'En prueba',
  ACTIVE: 'Al día',
  PAST_DUE: 'Pago vencido',
  SUSPENDED: 'Suspendida',
  EXPIRED: 'Prueba vencida',
  CANCELLED: 'Cancelada',
};

export type JourneyInput = {
  status: TenantStatus;
  timezone: string;
  statusChangedAt: string;
  trialEndsAt: string | null;
  cancelledAt: string | null;
  history: { toStatus: TenantStatus; occurredAt: string }[];
  /** Último día (inclusive) del período en curso, si hay suscripción. */
  periodLastDay: string | null;
  pastDueGraceDays: number;
  cancelledClosingDays: number;
};

export function journey(i: JourneyInput): { stops: Stop[]; next: string } {
  const local = (iso: string) => today(i.timezone, new Date(iso));
  const since = local(i.statusChangedAt);
  const last = i.status === 'EXPIRED' || i.status === 'CANCELLED' ? i.status : 'SUSPENDED';
  const order: TenantStatus[] = ['TRIAL', 'ACTIVE', 'PAST_DUE', last];
  const reached = new Set(i.history.map((h) => h.toStatus));
  const at = order.indexOf(i.status);
  const lastEntry = (s: TenantStatus) =>
    [...i.history].reverse().find((h) => h.toStatus === s)?.occurredAt ?? null;

  const stops = order.map((status, idx): Stop => {
    const state = status === i.status ? 'current' : idx < at && reached.has(status) ? 'done' : 'pending';
    const entered = lastEntry(status);
    const note =
      state === 'current'
        ? `Desde el ${date(since)}`
        : state === 'done' && entered
          ? `Desde el ${date(local(entered))}`
          : status === 'SUSPENDED' && i.status === 'PAST_DUE'
            ? `Próxima parada: ${date(addDays(since, i.pastDueGraceDays))}`
            : '—';
    return { status, label: LABEL[status], state, note };
  });

  const next = (() => {
    switch (i.status) {
      case 'TRIAL':
        return i.trialEndsAt ? `La prueba termina el ${date(local(i.trialEndsAt))}` : 'En prueba';
      case 'ACTIVE':
        return i.periodLastDay
          ? `Sin saldo vencido · el período cierra el ${date(i.periodLastDay)}`
          : 'Sin saldo vencido';
      case 'PAST_DUE':
        return `Se suspende el ${date(addDays(since, i.pastDueGraceDays))} si no se regulariza`;
      case 'SUSPENDED':
        return 'Se reactiva al registrar el pago del saldo vencido';
      case 'EXPIRED':
        return `Prueba vencida el ${date(since)}`;
      case 'CANCELLED':
        return `Cierre definitivo el ${date(addDays(local(i.cancelledAt ?? i.statusChangedAt), i.cancelledClosingDays))}`;
    }
  })();
  return { stops, next };
}
