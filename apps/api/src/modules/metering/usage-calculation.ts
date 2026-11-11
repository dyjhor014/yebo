import type { Prisma } from '../../generated/prisma/client';

/** Versión del algoritmo guardada en cada snapshot: un cambio de cálculo nunca reescribe días ya cerrados. */
export const USAGE_ALGORITHM_VERSION = 1;

export interface UsageDay {
  /** Inicio y fin absolutos del día local (23, 24 o 25 horas). */
  dayFrom: Date;
  dayTo: Date;
  peakConcurrent: number;
  distinctActive: number;
  /** Intervalos facturables recortados al día, para la auditoría. */
  intervals: { membershipId: string; from: string; to: string }[];
}

type Tx = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Valor de un día (billing §3), dentro de una transacción con el contexto del tenant ya fijado (RLS):
 * - día = `[D 00:00, D+1 00:00)` en la zona horaria dada, como rango absoluto (billing §2.2);
 * - `peak_concurrent`: máximo de membresías facturables a la vez; en un mismo instante, las salidas se cuentan antes
 *   que las entradas (un reemplazo inmediato no suma dos);
 * - `distinct_active`: membresías distintas facturables en algún momento del día;
 * - `min_active_seconds` (por plan, billing §7): se ignoran las filas cerradas que duraron menos.
 * Determinista: el historial no puede cambiar hacia atrás, así que recalcular un día terminado da lo mismo.
 */
export async function computeUsageDay(
  tx: Tx,
  input: { tenantId: string; date: string; timezone: string; minActiveSeconds: number },
): Promise<UsageDay> {
  const [row] = await tx.$queryRaw<
    {
      day_from: Date;
      day_to: Date;
      peak: number;
      distinct_active: number;
      intervals: { membershipId: string; from: string; to: string }[];
    }[]
  >`
    WITH day AS (
      SELECT tstzrange((${input.date}::date)::timestamp AT TIME ZONE ${input.timezone},
                       ((${input.date}::date + 1)::timestamp AT TIME ZONE ${input.timezone}), '[)') AS r
    ), iv AS (
      SELECT h.membership_id,
             tstzrange(h.valid_from, COALESCE(h.valid_to, 'infinity'), '[)') * day.r AS c
        FROM membership_status_history h, day
       WHERE h.tenant_id = ${input.tenantId}::uuid
         AND h.effective_billable
         AND tstzrange(h.valid_from, COALESCE(h.valid_to, 'infinity'), '[)') && day.r
         AND (h.valid_to IS NULL OR h.valid_to - h.valid_from >= make_interval(secs => ${input.minActiveSeconds}::int))
    ), ev AS (
      SELECT lower(c) AS t, 1 AS d FROM iv
      UNION ALL
      SELECT upper(c), -1 FROM iv, day WHERE upper(c) < upper(day.r)
    ), run AS (
      SELECT SUM(d) OVER (ORDER BY t, d ROWS UNBOUNDED PRECEDING) AS active FROM ev
    )
    SELECT lower(day.r) AS day_from, upper(day.r) AS day_to,
           COALESCE((SELECT MAX(active) FROM run), 0)::int AS peak,
           (SELECT COUNT(DISTINCT membership_id) FROM iv)::int AS distinct_active,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('membershipId', membership_id,
                                                         'from', lower(c), 'to', upper(c))
                                      ORDER BY membership_id, lower(c)) FROM iv), '[]'::jsonb) AS intervals
      FROM day`;
  if (!row) throw new Error('El cálculo del día no devolvió resultado');
  return {
    dayFrom: row.day_from,
    dayTo: row.day_to,
    peakConcurrent: row.peak,
    distinctActive: row.distinct_active,
    intervals: row.intervals,
  };
}

/** `min_active_seconds` de la versión de plan de la suscripción vigente (0 si no hay suscripción). */
export async function minActiveSecondsOf(tx: Tx): Promise<number> {
  const [row] = await tx.$queryRaw<{ s: number }[]>`
    SELECT pv.min_active_seconds AS s FROM subscriptions s JOIN plan_versions pv ON pv.id = s.plan_version_id
     WHERE s.is_current`;
  return row?.s ?? 0;
}
