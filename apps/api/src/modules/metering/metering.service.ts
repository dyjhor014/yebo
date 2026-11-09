import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { Clock } from '../identity/clock';
import { MeteringPrismaService } from './metering-prisma.service';
import { USAGE_ALGORITHM_VERSION, computeUsageDay, minActiveSecondsOf } from './usage-calculation';

type Tx = Prisma.TransactionClient;

/** Un día se cierra 15 minutos después de terminar en la zona horaria de la empresa (billing §4). */
export const DAY_CLOSE_MARGIN_MINUTES = 15;

/**
 * Snapshots diarios (billing §4; Fase 4.4). Por cada empresa, con su contexto fijado (RLS), calcula los días ya
 * terminados que aún no tienen snapshot FINAL y los guarda. Idempotente: `UNIQUE (tenant_id, usage_date)` +
 * `ON CONFLICT DO NOTHING`, así que dos ejecuciones simultáneas o un job caído varios días dan el mismo resultado.
 * La zona horaria es la de la empresa; desde la 4.5, la del período (fija durante el período).
 */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger(MeteringService.name);

  constructor(
    private readonly db: MeteringPrismaService,
    private readonly clock: Clock,
  ) {}

  /** Devuelve cuántos snapshots creó. */
  async runDue(): Promise<number> {
    const now = this.clock.now();
    const tenants = await this.db.client.tenant.findMany({ select: { id: true, timezone: true } });
    let created = 0;
    for (const tenant of tenants) {
      try {
        created += await this.closeDays(tenant.id, tenant.timezone, now);
      } catch (error) {
        // Una empresa con problemas no detiene a las demás; el siguiente ciclo la reintenta.
        this.logger.error({ err: error, tenantId: tenant.id }, 'No se pudieron calcular sus días');
      }
    }
    return created;
  }

  async closeDays(tenantId: string, timezone: string, now: Date): Promise<number> {
    return this.db.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        // Días pendientes: desde el primer día con historial hasta el último ya cerrado, sin snapshot FINAL.
        const pending = await tx.$queryRaw<{ d: string }[]>`
          WITH bounds AS (
            SELECT (min(valid_from) AT TIME ZONE ${timezone})::date AS first_day,
                   ((${now}::timestamptz - make_interval(mins => ${DAY_CLOSE_MARGIN_MINUTES}::int))
                     AT TIME ZONE ${timezone})::date - 1 AS last_day
              FROM membership_status_history
          )
          SELECT to_char(g.d, 'YYYY-MM-DD') AS d
            FROM bounds, generate_series(bounds.first_day, bounds.last_day, interval '1 day') AS g(d)
           WHERE bounds.first_day IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM usage_daily_snapshots s WHERE s.usage_date = g.d::date)
           ORDER BY g.d`;
        if (pending.length === 0) return 0;
        const minActiveSeconds = await minActiveSecondsOf(tx);
        let created = 0;
        for (const { d } of pending) {
          created += await insertSnapshot(tx, { tenantId, date: d, timezone, minActiveSeconds, now });
        }
        return created;
      },
      { timeout: 60_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}

/** Calcula y guarda el snapshot FINAL de un día terminado (idempotente). Devuelve 1 si lo creó. */
export async function insertSnapshot(
  tx: Tx,
  input: { tenantId: string; date: string; timezone: string; minActiveSeconds: number; now: Date },
): Promise<number> {
  const day = await computeUsageDay(tx, input);
  const detail = JSON.stringify({ minActiveSeconds: input.minActiveSeconds, intervals: day.intervals });
  return tx.$executeRaw`
    INSERT INTO usage_daily_snapshots (tenant_id, usage_date, timezone, day_range, peak_concurrent,
                                       distinct_active, status, algorithm_version, detail, computed_at)
    VALUES (${input.tenantId}::uuid, ${input.date}::date, ${input.timezone}, tstzrange(${day.dayFrom}, ${day.dayTo}, '[)'),
            ${day.peakConcurrent}, ${day.distinctActive}, 'FINAL', ${USAGE_ALGORITHM_VERSION},
            ${detail}::jsonb, ${input.now})
    ON CONFLICT (tenant_id, usage_date) DO NOTHING`;
}
