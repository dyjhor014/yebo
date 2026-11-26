import { Injectable } from '@nestjs/common';
import type { TripAvailability } from '@yebo/contracts';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { FleetContext } from '../fleet/fleet-context';

type Tx = Parameters<Parameters<TenantDbService['transaction']>[0]>[0];
const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, 400);

export type HolderType = 'BOOKING_ITEM' | 'TRANSFER' | 'CARGO_ASSIGNMENT' | 'BLOCK';

export interface AllocationRequest {
  tripId: string;
  /** Rango de paradas `[fromSeq, toSeq)`: ocupa los tramos fromSeq … toSeq-1. */
  fromSeq: number;
  toSeq: number;
  holderType: HolderType;
  holderId: string;
  /** Recursos por código; un camarote con camas ocupa todas sus camas (capacity-and-inventory §3, ejemplo D). */
  resourceCodes?: string[];
  pools?: { poolId: string; quantity: number }[];
  /** Con vencimiento, la asignación es una retención (HELD); sin él, confirmada. */
  holdExpiresAt?: Date | null;
}

export interface AllocationResult {
  resourceIds: string[];
  poolAllocationIds: string[];
}

const DIMENSION_NAME: Record<string, string> = {
  PERSONS: 'personas',
  UNITS: 'unidades',
  WEIGHT_KG: 'kg',
  VOLUME_M3: 'm³',
  LINEAR_M: 'm lineales',
};

const isPg = (e: unknown, code: string): boolean => {
  const text =
    e instanceof Error ? `${e.message} ${JSON.stringify((e as { cause?: unknown }).cause ?? {})}` : '';
  return text.includes(code);
};

/**
 * Motor de inventario por tramo (Fase 7.4; capacity-and-inventory §3–6; ADR-007 y ADR-026). Producción de la prueba de
 * concepto de la Fase 2, sobre las tablas reales con RLS y `yebo_app`, en READ COMMITTED.
 * - Recursos: candados consultivos de transacción por recurso, en orden de id (ADR-026: la segunda venta espera a la
 *   primera en vez de interbloquearse dentro del índice GIST; con candado de fila haría falta UPDATE sobre
 *   `trip_resources`), aviso previo con el código y la garantía final de la exclusión `resource_no_overlap`.
 * - Cupos: bloqueo de los contadores con FOR UPDATE en el orden global `(pool_id, segment_seq)`, comprobación con los
 *   valores confirmados, incremento (el CHECK `pool_within_capacity` es la red final) y registro de la asignación.
 * - Recursos y cupos en una sola transacción: si algo falla, no se asigna nada. Orden global: recursos, luego pools.
 * - Las retenciones vencidas que estorban se liberan **enteras** (todas las asignaciones de su titular) en una
 *   transacción previa (ejemplo C): una retención nunca desaparece sin dejar registro.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly db: TenantDbService,
    private readonly ctx: FleetContext,
  ) {}

  /** Asigna en su propia transacción (antes libera las retenciones vencidas que estorban). */
  async allocate(req: AllocationRequest): Promise<AllocationResult> {
    await this.releaseExpired(req);
    return this.db.transaction((tx) => this.allocateIn(tx, req));
  }

  /** Asigna dentro de la transacción del llamador (p. ej., junto con el bloqueo o la reserva que es su titular). */
  async allocateIn(tx: Tx, req: AllocationRequest): Promise<AllocationResult> {
    const status = req.holdExpiresAt ? 'HELD' : 'CONFIRMED';
    if (req.holdExpiresAt && req.holdExpiresAt <= this.ctx.now()) {
      throw invalid('El vencimiento es posterior a este momento');
    }
    const segments = await this.lockTripForSale(tx, req.tripId);
    if (!(req.fromSeq >= 0 && req.fromSeq < req.toSeq && req.toSeq <= segments.length)) {
      throw invalid('Ese tramo no es del viaje');
    }
    const resourceIds = req.resourceCodes?.length
      ? await this.allocateResources(tx, req, status, segments)
      : [];
    const poolAllocationIds = req.pools?.length ? await this.allocatePools(tx, req, status, segments) : [];
    return { resourceIds, poolAllocationIds };
  }

  /** Libera todo lo asignado a los titulares (recursos y cupos), en su propia transacción. */
  async release(holderIds: string[]): Promise<void> {
    await this.db.transaction((tx) => this.releaseIn(tx, holderIds, false));
  }

  /**
   * Libera las asignaciones activas de los titulares en la transacción en curso. Los contadores afectados se bloquean
   * en una sola consulta con el orden global `(pool_id, segment_seq)`, el mismo de la asignación: sin interbloqueos.
   */
  async releaseIn(tx: Tx, holderIds: string[], onlyExpired: boolean): Promise<void> {
    if (holderIds.length === 0) return;
    const now = this.ctx.now();
    await tx.$executeRaw`
      UPDATE resource_allocations SET status = 'RELEASED', released_at = ${now}
       WHERE holder_id = ANY(${holderIds}::uuid[]) AND status <> 'RELEASED'
         AND (NOT ${onlyExpired} OR (status = 'HELD' AND hold_expires_at < ${now}))`;
    const allocations = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM pool_allocations
       WHERE holder_id = ANY(${holderIds}::uuid[]) AND status <> 'RELEASED'
         AND (NOT ${onlyExpired} OR (status = 'HELD' AND hold_expires_at < ${now}))`;
    if (allocations.length === 0) return;
    const ids = allocations.map((a) => a.id);
    await tx.$queryRaw`
      SELECT 1 FROM trip_pool_segment_usage u
       WHERE EXISTS (SELECT 1 FROM pool_allocations a
                      WHERE a.id = ANY(${ids}::uuid[]) AND a.pool_id = u.pool_id AND a.stop_range @> u.segment_seq)
       ORDER BY u.pool_id, u.segment_seq FOR UPDATE`;
    await tx.$executeRaw`
      UPDATE trip_pool_segment_usage u SET used = u.used - d.qty
        FROM (SELECT s.pool_id, s.segment_seq, sum(a.quantity) AS qty
                FROM trip_pool_segment_usage s
                JOIN pool_allocations a ON a.pool_id = s.pool_id AND a.stop_range @> s.segment_seq
               WHERE a.id = ANY(${ids}::uuid[])
               GROUP BY s.pool_id, s.segment_seq) d
       WHERE u.pool_id = d.pool_id AND u.segment_seq = d.segment_seq`;
    await tx.$executeRaw`
      UPDATE pool_allocations SET status = 'RELEASED', released_at = ${now} WHERE id = ANY(${ids}::uuid[])`;
  }

  /** Disponibilidad tramo por tramo de cada recurso vendible y de cada pool (las retenciones vencidas no ocupan). */
  async availability(tripId: string): Promise<TripAvailability> {
    if (!UUID.safeParse(tripId).success) throw NOT_FOUND();
    const now = this.ctx.now();
    return this.db.transaction(async (tx) => {
      const trip = await tx.trip.findFirst({ where: { id: tripId }, select: { status: true } });
      if (!trip) throw NOT_FOUND();
      const segments = await this.segments(tx, tripId);
      const resources = await tx.$queryRaw<
        { code: string; kind: string; zone_code: string; price_class_code: string; busy: number[] | null }[]
      >`
        SELECT r.code, r.kind::text AS kind, r.zone_code, r.price_class_code,
               (SELECT array_agg(DISTINCT s.seq ORDER BY s.seq)
                  FROM resource_allocations a
                  JOIN trip_resources leaf ON leaf.id = a.trip_resource_id
                  CROSS JOIN generate_series(lower(a.stop_range), upper(a.stop_range) - 1) AS s(seq)
                 WHERE (leaf.id = r.id OR leaf.parent_trip_resource_id = r.id)
                   AND a.status <> 'RELEASED' AND NOT (a.status = 'HELD' AND a.hold_expires_at < ${now})) AS busy
          FROM trip_resources r
         WHERE r.trip_id = ${tripId}::uuid AND (r.is_sellable OR r.sellable_as_unit)
         ORDER BY r.code`;
      const pools = await tx.$queryRaw<
        {
          id: string;
          scope: 'ZONE' | 'VEHICLE';
          zone_code: string | null;
          dimension: string;
          capacity: string;
          used: string[];
        }[]
      >`
        SELECT p.id::text, p.scope::text AS scope, p.zone_code, p.dimension::text AS dimension, p.capacity::text,
               ARRAY(SELECT coalesce(sum(a.quantity), 0)::text
                       FROM generate_series(0, ${segments.length}::int - 1) AS s(seq)
                       LEFT JOIN pool_allocations a
                              ON a.pool_id = p.id AND a.stop_range @> s.seq AND a.status <> 'RELEASED'
                             AND NOT (a.status = 'HELD' AND a.hold_expires_at < ${now})
                      GROUP BY s.seq ORDER BY s.seq) AS used
          FROM trip_capacity_pools p WHERE p.trip_id = ${tripId}::uuid
         ORDER BY p.scope, p.zone_code NULLS FIRST, p.dimension`;
      return {
        tripId,
        status: trip.status,
        segments,
        resources: resources.map((r) => {
          const busy = new Set(r.busy ?? []);
          return {
            code: r.code,
            kind: r.kind,
            zoneCode: r.zone_code,
            priceClassCode: r.price_class_code,
            free: segments.map((s) => !busy.has(s.seq)),
          };
        }),
        pools: pools.map((p) => {
          const capacity = Number(p.capacity);
          const used = p.used.map(Number);
          return {
            id: p.id,
            scope: p.scope,
            zoneCode: p.zone_code,
            dimension: p.dimension,
            capacity,
            used,
            free: used.map((u) => capacity - u),
          };
        }),
      };
    });
  }

  /**
   * Reconciliación (capacity-and-inventory §6.8): en cada pool y tramo de la empresa, `used` = Σ de las asignaciones
   * no liberadas que cubren el tramo. Devuelve las filas que no cumplen (vacío si todo cuadra).
   */
  async reconciliation(): Promise<{ poolId: string; segmentSeq: number; used: number; expected: number }[]> {
    const rows = await this.db.transaction(
      (tx) => tx.$queryRaw<{ pool_id: string; segment_seq: number; used: string; expected: string }[]>`
        SELECT u.pool_id::text, u.segment_seq, u.used::text, coalesce(sum(a.quantity), 0)::text AS expected
          FROM trip_pool_segment_usage u
          LEFT JOIN pool_allocations a
                 ON a.pool_id = u.pool_id AND a.status <> 'RELEASED' AND a.stop_range @> u.segment_seq
         GROUP BY u.pool_id, u.segment_seq, u.used
        HAVING u.used <> coalesce(sum(a.quantity), 0)`,
    );
    return rows.map((r) => ({
      poolId: r.pool_id,
      segmentSeq: r.segment_seq,
      used: Number(r.used),
      expected: Number(r.expected),
    }));
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** El viaje, bloqueado en modo compartido, a la venta; devuelve sus tramos. */
  private async lockTripForSale(tx: Tx, tripId: string) {
    if (!UUID.safeParse(tripId).success) throw NOT_FOUND();
    const [trip] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM trips WHERE id = ${tripId}::uuid FOR SHARE`;
    if (!trip) throw NOT_FOUND();
    if (trip.status !== 'OPEN_FOR_SALE') {
      throw new AppError('CONFLICT', 'El viaje no está a la venta', 409);
    }
    return this.segments(tx, tripId);
  }

  private async segments(tx: Tx, tripId: string) {
    const stops = await tx.tripStop.findMany({
      where: { tripId },
      orderBy: { seq: 'asc' },
      select: { seq: true, location: { select: { name: true } } },
    });
    return stops.slice(0, -1).map((s, i) => ({
      seq: s.seq,
      from: s.location.name,
      to: stops[i + 1]?.location.name ?? '',
    }));
  }

  private async allocateResources(
    tx: Tx,
    req: AllocationRequest,
    status: 'HELD' | 'CONFIRMED',
    segments: { seq: number; from: string; to: string }[],
  ): Promise<string[]> {
    const codes = [...new Set(req.resourceCodes ?? [])];
    const selected = await tx.$queryRaw<{ id: string; code: string }[]>`
      SELECT id::text, code FROM trip_resources WHERE trip_id = ${req.tripId}::uuid AND code = ANY(${codes}::text[])`;
    if (selected.length !== codes.length) {
      const found = new Set(selected.map((r) => r.code));
      throw invalid(`El viaje no tiene ${codes.filter((c) => !found.has(c)).join(', ')}`);
    }
    const children = await tx.$queryRaw<{ id: string; code: string; parent: string }[]>`
      SELECT id::text, code, parent_trip_resource_id::text AS parent FROM trip_resources
       WHERE trip_id = ${req.tripId}::uuid AND parent_trip_resource_id = ANY(${selected.map((r) => r.id)}::uuid[])`;
    const parents = new Set(children.map((c) => c.parent));
    // Sin duplicados: pedir un camarote y una de sus camas no asigna la cama dos veces.
    const leaves = new Map<string, string>();
    for (const r of [...selected.filter((r) => !parents.has(r.id)), ...children]) leaves.set(r.id, r.code);
    const ids = [...leaves.keys()].sort();
    // ADR-026: las asignaciones que compiten por un recurso esperan aquí, en orden, y no dentro del índice GIST.
    for (const id of ids)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}::text, 0))`;
    // Lo ocupado, con el tramo exacto donde choca cada lugar (del primer al último tramo ocupado dentro de lo pedido).
    const busy = await tx.$queryRaw<{ code: string; lo: number; hi: number }[]>`
      SELECT r.code,
             min(greatest(lower(a.stop_range), ${req.fromSeq}::int))::int AS lo,
             max(least(upper(a.stop_range), ${req.toSeq}::int))::int AS hi
        FROM resource_allocations a JOIN trip_resources r ON r.id = a.trip_resource_id
       WHERE a.trip_resource_id = ANY(${ids}::uuid[]) AND a.status <> 'RELEASED'
         AND a.stop_range && int4range(${req.fromSeq}::int, ${req.toSeq}::int)
       GROUP BY r.code
       ORDER BY lo, hi, r.code`;
    if (busy.length > 0) throw unavailableBySegment(busy, segments);
    try {
      await tx.$executeRaw`
        INSERT INTO resource_allocations (id, tenant_id, trip_id, trip_resource_id, stop_range, status,
                                          hold_expires_at, holder_type, holder_id)
        SELECT gen_random_uuid(), ${this.ctx.tenantId()}::uuid, ${req.tripId}::uuid, rid,
               int4range(${req.fromSeq}::int, ${req.toSeq}::int), ${status}::allocation_status,
               ${req.holdExpiresAt ?? null}::timestamptz, ${req.holderType}::allocation_holder, ${req.holderId}::uuid
          FROM unnest(${ids}::uuid[]) AS t(rid)`;
    } catch (e) {
      // La exclusión es la garantía final (p. ej., una retención que venció justo después del aviso previo).
      if (isPg(e, '23P01') || isPg(e, 'resource_no_overlap'))
        throw unavailable(
          [...leaves.values()].sort(),
          `entre ${segments[req.fromSeq]?.from} y ${segments[req.toSeq - 1]?.to}`,
        );
      throw e;
    }
    return ids;
  }

  private async allocatePools(
    tx: Tx,
    req: AllocationRequest,
    status: 'HELD' | 'CONFIRMED',
    segments: { seq: number; from: string; to: string }[],
  ): Promise<string[]> {
    // Un mismo pool pedido dos veces se suma en una sola demanda.
    const byPool = new Map<string, number>();
    for (const d of req.pools ?? []) byPool.set(d.poolId, (byPool.get(d.poolId) ?? 0) + d.quantity);
    const demands = [...byPool].sort(([a], [b]) => a.localeCompare(b));
    const poolIds = demands.map(([id]) => id);
    const quantities = demands.map(([, q]) => String(q));
    if (poolIds.some((id) => !UUID.safeParse(id).success))
      throw invalid('Uno de los cupos no es de este viaje');
    const pools = await tx.$queryRaw<
      { id: string; scope: string; zone_code: string | null; dimension: string }[]
    >`
      SELECT id::text, scope::text AS scope, zone_code, dimension::text AS dimension FROM trip_capacity_pools
       WHERE trip_id = ${req.tripId}::uuid AND id = ANY(${poolIds}::uuid[])`;
    if (pools.length !== poolIds.length) throw invalid('Uno de los cupos no es de este viaje');

    // 1) Bloqueo de TODAS las filas necesarias en el orden global (pool_id, segment_seq).
    const locked = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM trip_pool_segment_usage
         WHERE pool_id = ANY(${poolIds}::uuid[]) AND segment_seq >= ${req.fromSeq}::int AND segment_seq < ${req.toSeq}::int
         ORDER BY pool_id, segment_seq FOR UPDATE) l`;
    if (locked[0]?.n !== poolIds.length * (req.toSeq - req.fromSeq)) {
      throw new AppError('CONFLICT', 'Los cupos del viaje no están listos para la venta', 409);
    }
    // 2) Comprobación con los valores confirmados más recientes (FOR UPDATE relee tras esperar).
    const [full] = await tx.$queryRaw<{ pool_id: string; segment_seq: number }[]>`
      WITH d(pool_id, qty) AS (SELECT * FROM unnest(${poolIds}::uuid[], ${quantities}::numeric[]))
      SELECT u.pool_id::text, u.segment_seq FROM trip_pool_segment_usage u JOIN d USING (pool_id)
       WHERE u.segment_seq >= ${req.fromSeq}::int AND u.segment_seq < ${req.toSeq}::int AND u.used + d.qty > u.capacity
       ORDER BY u.pool_id, u.segment_seq LIMIT 1`;
    if (full) {
      const pool = pools.find((p) => p.id === full.pool_id);
      const segment = segments[full.segment_seq];
      throw new AppError(
        'CAPACITY_EXCEEDED',
        `${poolName(pool)} sin capacidad entre ${segment?.from} y ${segment?.to}`,
        409,
      );
    }
    // 3) Incremento: el CHECK pool_within_capacity es la red final.
    try {
      await tx.$executeRaw`
        WITH d(pool_id, qty) AS (SELECT * FROM unnest(${poolIds}::uuid[], ${quantities}::numeric[]))
        UPDATE trip_pool_segment_usage u SET used = u.used + d.qty
          FROM d WHERE u.pool_id = d.pool_id AND u.segment_seq >= ${req.fromSeq}::int AND u.segment_seq < ${req.toSeq}::int`;
    } catch (e) {
      if (isPg(e, '23514') || isPg(e, 'pool_within_capacity')) {
        throw new AppError('CAPACITY_EXCEEDED', 'Un cupo no tiene capacidad en ese tramo', 409);
      }
      throw e;
    }
    // 4) Registro de cada asignación, para liberarla exactamente.
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO pool_allocations (id, tenant_id, pool_id, stop_range, quantity, status, hold_expires_at,
                                    holder_type, holder_id)
      SELECT gen_random_uuid(), ${this.ctx.tenantId()}::uuid, pid, int4range(${req.fromSeq}::int, ${req.toSeq}::int), qty,
             ${status}::allocation_status, ${req.holdExpiresAt ?? null}::timestamptz,
             ${req.holderType}::allocation_holder, ${req.holderId}::uuid
        FROM unnest(${poolIds}::uuid[], ${quantities}::numeric[]) AS t(pid, qty)
      RETURNING id::text`;
    return rows.map((r) => r.id);
  }

  /**
   * Ejemplo C: libera, enteras, las retenciones vencidas que ocupan los recursos o cupos pedidos, en su propia
   * transacción. Quien asigna dentro de su transacción (allocateIn) la llama antes.
   */
  async releaseExpired(req: AllocationRequest): Promise<void> {
    const codes = req.resourceCodes ?? [];
    const poolIds = (req.pools ?? []).map((p) => p.poolId).filter((id) => UUID.safeParse(id).success);
    if ((codes.length === 0 && poolIds.length === 0) || !UUID.safeParse(req.tripId).success) return;
    const now = this.ctx.now();
    await this.db.transaction(async (tx) => {
      const holders = await tx.$queryRaw<{ holder_id: string }[]>`
        SELECT a.holder_id::text FROM resource_allocations a
          JOIN trip_resources r ON r.id = a.trip_resource_id
          LEFT JOIN trip_resources parent ON parent.id = r.parent_trip_resource_id
         WHERE a.trip_id = ${req.tripId}::uuid AND a.status = 'HELD' AND a.hold_expires_at < ${now}
           AND (r.code = ANY(${codes}::text[]) OR parent.code = ANY(${codes}::text[]))
        UNION
        SELECT holder_id::text FROM pool_allocations
         WHERE pool_id = ANY(${poolIds}::uuid[]) AND status = 'HELD' AND hold_expires_at < ${now}`;
      await this.releaseIn(
        tx,
        holders.map((h) => h.holder_id),
        true,
      );
    });
  }
}

function unavailable(codes: string[], between: string): AppError {
  return new AppError(
    'RESOURCE_UNAVAILABLE',
    `${codes.length === 1 ? 'Ocupado' : 'Ocupados'} ${between}: ${codes.join(', ')}`,
    409,
  );
}

/**
 * Lugares ocupados con su tramo exacto, agrupados por tramo: «Ocupado entre Contamana y Yurimaguas: C1-B2» o
 * «Ocupados entre Pucallpa y Contamana: 1A, 1B; entre Contamana y Iquitos: 5A».
 */
function unavailableBySegment(
  busy: { code: string; lo: number; hi: number }[],
  segments: { from: string; to: string }[],
): AppError {
  const groups = new Map<string, string[]>();
  for (const b of busy) {
    const key = `entre ${segments[b.lo]?.from} y ${segments[b.hi - 1]?.to}`;
    groups.set(key, [...(groups.get(key) ?? []), b.code]);
  }
  const parts = [...groups].map(([between, codes]) => `${between}: ${codes.join(', ')}`);
  return new AppError(
    'RESOURCE_UNAVAILABLE',
    `${busy.length === 1 ? 'Ocupado' : 'Ocupados'} ${parts.join('; ')}`,
    409,
  );
}

function poolName(p: { scope: string; zone_code: string | null; dimension: string } | undefined): string {
  if (!p) return 'Un cupo';
  if (p.scope === 'VEHICLE') return 'El aforo de la unidad';
  return `La zona ${p.zone_code} (${DIMENSION_NAME[p.dimension] ?? p.dimension})`;
}
