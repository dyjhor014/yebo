/**
 * PRUEBA DE CONCEPTO (Fase 2) — motor de asignación de inventario por tramos.
 * Implementa capacity-and-inventory.md §3 y §4 para validar el diseño contra PostgreSQL real.
 * No es el módulo de producción: el módulo `inventory` se construye en la Fase 7 a partir de este resultado.
 *
 * Garantías que se validan:
 *  - Recursos asignables: EXCLUDE USING gist (trip_resource_id =, stop_range &&) → sin doble venta.
 *  - Capacidades agregadas: SELECT … FOR UPDATE en orden (pool_id, segment_seq) + CHECK (used <= capacity).
 *  - Nivel de aislamiento READ COMMITTED (predeterminado). Sin SERIALIZABLE.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export class ResourceUnavailableError extends Error {
  constructor(readonly resourceCodes: string[]) {
    super(`Recurso no disponible en el tramo solicitado: ${resourceCodes.join(', ')}`);
    this.name = 'ResourceUnavailableError';
  }
}

export class CapacityExceededError extends Error {
  constructor(
    readonly poolId: string,
    readonly segmentSeq: number | null,
  ) {
    super(`Capacidad agotada en el pool ${poolId}${segmentSeq === null ? '' : `, tramo ${segmentSeq}`}`);
    this.name = 'CapacityExceededError';
  }
}

export class InvalidSaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSaleError';
  }
}

export interface PoolDemand {
  poolId: string;
  quantity: number;
}

export interface SaleRequest {
  tenantId: string;
  tripId: string;
  fromSeq: number;
  toSeq: number;
  holderId: string;
  holderType?: 'BOOKING_ITEM' | 'CARGO_ASSIGNMENT' | 'TRANSFER' | 'BLOCK';
  resourceCodes?: string[];
  poolDemands?: PoolDemand[];
  status?: 'HELD' | 'CONFIRMED';
  holdExpiresAt?: Date;
  /**
   * ADR-026 (aceptado): bloquear antes las filas de los recursos (ORDER BY id FOR NO KEY UPDATE).
   * Evita el interbloqueo (40P01) que la restricción de exclusión produce cuando dos inserciones
   * conflictivas son simultáneas. Predeterminado: `true`. `false` solo reproduce, en la prueba de
   * referencia, el diseño anterior a ADR-026.
   */
  serializeResourceContention?: boolean;
}

export interface SaleResult {
  resourceIds: string[];
  poolAllocationIds: string[];
}

type PgError = Error & { code?: string; constraint?: string };

function isPgError(error: unknown): error is PgError {
  return error instanceof Error && typeof (error as PgError).code === 'string';
}

async function inTenantTransaction<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // Si el ROLLBACK falla, la conexión queda en un estado desconocido: se descarta en lugar de devolverla al pool.
  let broken: Error | undefined;
  try {
    await client.query('BEGIN'); // READ COMMITTED
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error; // siempre el error original, nunca el del ROLLBACK
  } finally {
    client.release(broken);
  }
}

/** Expande camarotes con camas a sus camas (capacity-and-inventory §3, ejemplo D). */
async function resolveLeafResources(
  client: PoolClient,
  tripId: string,
  codes: string[],
): Promise<{ id: string; code: string }[]> {
  const selected = await client.query<{ id: string; code: string }>(
    'SELECT id, code FROM inv_trip_resources WHERE trip_id = $1 AND code = ANY($2::text[])',
    [tripId, codes],
  );
  if (selected.rowCount !== new Set(codes).size)
    throw new InvalidSaleError('Recurso inexistente en el viaje');
  const children = await client.query<{ id: string; code: string; parent_id: string }>(
    'SELECT id, code, parent_id FROM inv_trip_resources WHERE trip_id = $1 AND parent_id = ANY($2::uuid[])',
    [tripId, selected.rows.map((r) => r.id)],
  );
  const parentsWithChildren = new Set(children.rows.map((c) => c.parent_id));
  // Sin duplicados: pedir un camarote y una de sus camas no debe asignar la cama dos veces.
  const leaves = new Map<string, { id: string; code: string }>();
  for (const r of [...selected.rows.filter((r) => !parentsWithChildren.has(r.id)), ...children.rows]) {
    leaves.set(r.id, { id: r.id, code: r.code });
  }
  // Orden determinista: dos ventas que compiten por varios recursos esperan en el mismo orden (sin deadlocks).
  return [...leaves.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function allocateResources(client: PoolClient, req: SaleRequest, status: string): Promise<string[]> {
  const leaves = await resolveLeafResources(client, req.tripId, req.resourceCodes ?? []);
  const ids = leaves.map((l) => l.id);

  if (req.serializeResourceContention ?? true) {
    // Las ventas que compiten por el mismo recurso esperan aquí, en orden, en lugar de esperarse
    // mutuamente dentro del índice GIST. La garantía sigue siendo la restricción de exclusión.
    await client.query(
      'SELECT id FROM inv_trip_resources WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE',
      [ids],
    );
  }

  try {
    await client.query(
      `INSERT INTO inv_resource_allocations
         (id, tenant_id, trip_id, trip_resource_id, stop_range, status, hold_expires_at, holder_type, holder_id)
       SELECT gen_random_uuid(), $1, $2, rid, int4range($4, $5), $6, $7, $8, $9
         FROM unnest($3::uuid[]) WITH ORDINALITY AS t(rid, ord) ORDER BY ord`,
      [
        req.tenantId,
        req.tripId,
        ids,
        req.fromSeq,
        req.toSeq,
        status,
        req.holdExpiresAt ?? null,
        req.holderType ?? 'BOOKING_ITEM',
        req.holderId,
      ],
    );
  } catch (error) {
    if (isPgError(error) && error.code === '23P01') {
      throw new ResourceUnavailableError(leaves.map((l) => l.code));
    }
    throw error;
  }
  return ids;
}

async function allocatePools(client: PoolClient, req: SaleRequest, status: string): Promise<string[]> {
  // Un mismo pool pedido dos veces se suma en una sola demanda (si no, el recuento de filas bloqueadas falla).
  const byPool = new Map<string, number>();
  for (const d of req.poolDemands ?? []) byPool.set(d.poolId, (byPool.get(d.poolId) ?? 0) + d.quantity);
  const demands = [...byPool]
    .map(([poolId, quantity]) => ({ poolId, quantity }))
    .sort((a, b) => a.poolId.localeCompare(b.poolId));
  const poolIds = demands.map((d) => d.poolId);
  const quantities = demands.map((d) => String(d.quantity));

  // 1) Bloqueo de TODAS las filas necesarias en orden global determinista.
  const locked = await client.query(
    `SELECT pool_id, segment_seq FROM inv_pool_segment_usage
      WHERE pool_id = ANY($1::uuid[]) AND segment_seq >= $2 AND segment_seq < $3
      ORDER BY pool_id, segment_seq FOR UPDATE`,
    [poolIds, req.fromSeq, req.toSeq],
  );
  if (locked.rowCount !== demands.length * (req.toSeq - req.fromSeq)) {
    throw new InvalidSaleError('Los contadores por tramo no están materializados para este viaje');
  }

  // 2) Verificación con los valores confirmados más recientes (FOR UPDATE relee tras esperar).
  const exceeded = await client.query<{ pool_id: string; segment_seq: number }>(
    `WITH d(pool_id, qty) AS (SELECT * FROM unnest($1::uuid[], $2::numeric[]))
     SELECT u.pool_id, u.segment_seq FROM inv_pool_segment_usage u JOIN d USING (pool_id)
      WHERE u.segment_seq >= $3 AND u.segment_seq < $4 AND u.used + d.qty > u.capacity
      ORDER BY u.pool_id, u.segment_seq LIMIT 1`,
    [poolIds, quantities, req.fromSeq, req.toSeq],
  );
  const first = exceeded.rows[0];
  if (first) throw new CapacityExceededError(first.pool_id, first.segment_seq);

  // 3) Incremento (el CHECK used <= capacity es la red de seguridad final).
  try {
    await client.query(
      `WITH d(pool_id, qty) AS (SELECT * FROM unnest($1::uuid[], $2::numeric[]))
       UPDATE inv_pool_segment_usage u SET used = u.used + d.qty
         FROM d WHERE u.pool_id = d.pool_id AND u.segment_seq >= $3 AND u.segment_seq < $4`,
      [poolIds, quantities, req.fromSeq, req.toSeq],
    );
  } catch (error) {
    if (isPgError(error) && error.code === '23514') throw new CapacityExceededError(poolIds[0] ?? '?', null);
    throw error;
  }

  // 4) Registro de la asignación para poder liberarla exactamente.
  const allocationIds = demands.map(() => randomUUID());
  await client.query(
    `INSERT INTO inv_pool_allocations (id, tenant_id, pool_id, stop_range, quantity, status, hold_expires_at, holder_type, holder_id)
     SELECT aid, $1, pid, int4range($5, $6), qty, $7, $8, $9, $10
       FROM unnest($2::uuid[], $3::uuid[], $4::numeric[]) AS t(aid, pid, qty)`,
    [
      req.tenantId,
      allocationIds,
      poolIds,
      quantities,
      req.fromSeq,
      req.toSeq,
      status,
      req.holdExpiresAt ?? null,
      req.holderType ?? 'BOOKING_ITEM',
      req.holderId,
    ],
  );
  return allocationIds;
}

/** Venta o retención atómica: recursos + pools en una sola transacción. Si algo falla, no se asigna nada. */
export async function sell(pool: Pool, req: SaleRequest): Promise<SaleResult> {
  const status = req.status ?? 'CONFIRMED';
  // async: los errores de validación llegan como promesa rechazada, nunca como excepción síncrona.
  if (status === 'HELD' && !req.holdExpiresAt)
    throw new InvalidSaleError('Una retención requiere vencimiento');
  // Ejemplo C: las retenciones vencidas que estorban se liberan ENTERAS (recursos + pools) en una
  // transacción previa, sin depender de la frecuencia del job. Si una vence justo después, la
  // exclusión y el CHECK siguen garantizando que no hay doble venta (como mucho, falla y se reintenta).
  await releaseExpiredHolds(pool, req);
  return inTenantTransaction(pool, req.tenantId, async (client) => {
    const trip = await client.query<{ stop_count: number; status: string }>(
      'SELECT stop_count, status FROM inv_trips WHERE id = $1 FOR SHARE',
      [req.tripId],
    );
    const row = trip.rows[0];
    if (!row) throw new InvalidSaleError('Viaje inexistente');
    if (row.status !== 'OPEN_FOR_SALE') throw new InvalidSaleError('El viaje no está abierto a la venta');
    if (!(req.fromSeq >= 0 && req.toSeq <= row.stop_count - 1 && req.fromSeq < req.toSeq)) {
      throw new InvalidSaleError('Tramo inválido');
    }
    const resourceIds = req.resourceCodes?.length ? await allocateResources(client, req, status) : [];
    const poolAllocationIds = req.poolDemands?.length ? await allocatePools(client, req, status) : [];
    return { resourceIds, poolAllocationIds };
  });
}

/**
 * Libera las asignaciones activas de los titulares indicados (recursos + pools), en la transacción en curso.
 * Bloquea TODOS los contadores afectados en una sola consulta con el orden global (pool_id, segment_seq),
 * el mismo que usa la venta: liberar varias asignaciones de un titular nunca invierte el orden (sin 40P01).
 * `onlyExpired` limita la liberación a retenciones vencidas.
 */
async function releaseHolders(client: PoolClient, holderIds: string[], onlyExpired: boolean): Promise<void> {
  if (holderIds.length === 0) return;
  const scope = onlyExpired ? `AND status = 'HELD' AND hold_expires_at < now()` : `AND status <> 'RELEASED'`;
  await client.query(
    `UPDATE inv_resource_allocations SET status = 'RELEASED' WHERE holder_id = ANY($1::uuid[]) ${scope}`,
    [holderIds],
  );
  const { rows: allocations } = await client.query<{ id: string }>(
    `SELECT id FROM inv_pool_allocations WHERE holder_id = ANY($1::uuid[]) ${scope}`,
    [holderIds],
  );
  if (allocations.length === 0) return;
  const ids = allocations.map((a) => a.id);
  await client.query(
    `SELECT 1 FROM inv_pool_segment_usage u
      WHERE EXISTS (SELECT 1 FROM inv_pool_allocations a
                     WHERE a.id = ANY($1::uuid[]) AND a.pool_id = u.pool_id AND a.stop_range @> u.segment_seq)
      ORDER BY u.pool_id, u.segment_seq FOR UPDATE`,
    [ids],
  );
  await client.query(
    `UPDATE inv_pool_segment_usage u SET used = u.used - d.qty
       FROM (SELECT s.pool_id, s.segment_seq, sum(a.quantity) AS qty
               FROM inv_pool_segment_usage s
               JOIN inv_pool_allocations a ON a.pool_id = s.pool_id AND a.stop_range @> s.segment_seq
              WHERE a.id = ANY($1::uuid[])
              GROUP BY s.pool_id, s.segment_seq) d
      WHERE u.pool_id = d.pool_id AND u.segment_seq = d.segment_seq`,
    [ids],
  );
  await client.query(`UPDATE inv_pool_allocations SET status = 'RELEASED' WHERE id = ANY($1::uuid[])`, [ids]);
}

/** Libera, completas, las retenciones vencidas que ocupan los recursos o pools que pide la venta. */
async function releaseExpiredHolds(pool: Pool, req: SaleRequest): Promise<void> {
  const codes = req.resourceCodes ?? [];
  const poolIds = (req.poolDemands ?? []).map((d) => d.poolId);
  if (codes.length === 0 && poolIds.length === 0) return;
  await inTenantTransaction(pool, req.tenantId, async (client) => {
    const { rows } = await client.query<{ holder_id: string }>(
      `SELECT a.holder_id FROM inv_resource_allocations a
         JOIN inv_trip_resources r ON r.id = a.trip_resource_id
         LEFT JOIN inv_trip_resources parent ON parent.id = r.parent_id
        WHERE a.trip_id = $1 AND a.status = 'HELD' AND a.hold_expires_at < now()
          AND (r.code = ANY($2::text[]) OR parent.code = ANY($2::text[]))
       UNION
       SELECT holder_id FROM inv_pool_allocations
        WHERE pool_id = ANY($3::uuid[]) AND status = 'HELD' AND hold_expires_at < now()`,
      [req.tripId, codes, poolIds],
    );
    await releaseHolders(
      client,
      rows.map((r) => r.holder_id),
      true,
    );
  });
}

/** Libera todo lo asignado a un titular (cancelación, expiración o reembolso), en una transacción. */
export function release(pool: Pool, tenantId: string, holderId: string): Promise<void> {
  return inTenantTransaction(pool, tenantId, (client) => releaseHolders(client, [holderId], false));
}

/**
 * Invariante de reconciliación (capacity-and-inventory §6.8): para cada pool y tramo,
 * used = Σ quantity de asignaciones activas que cubren el tramo. Devuelve las filas inconsistentes.
 */
export async function reconciliationViolations(platformPool: Pool): Promise<unknown[]> {
  const { rows } = await platformPool.query(
    `SELECT u.pool_id, u.segment_seq, u.used, COALESCE(sum(a.quantity), 0) AS expected
       FROM inv_pool_segment_usage u
       LEFT JOIN inv_pool_allocations a
              ON a.pool_id = u.pool_id AND a.status <> 'RELEASED' AND a.stop_range @> u.segment_seq
      GROUP BY u.pool_id, u.segment_seq, u.used
     HAVING u.used <> COALESCE(sum(a.quantity), 0)`,
  );
  return rows;
}
