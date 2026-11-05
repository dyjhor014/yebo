/**
 * PRUEBA DE CONCEPTO 2 (Fase 2) — concurrencia e inventario por tramos (ADR-007).
 * Casos de capacity-and-inventory.md §6 y ejemplos A–H, contra PostgreSQL real con el rol yebo_app (RLS activo).
 *
 * Ruta de prueba (4 paradas, 3 tramos):  Pucallpa(0) → Contamana(1) → Yurimaguas(2) → Iquitos(3)
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { testPool } from '../../support/db';
import {
  CapacityExceededError,
  ResourceUnavailableError,
  reconciliationViolations,
  release,
  sell,
  type SaleRequest,
} from './allocator';

const DB = 'yebo_poc_inventory';
const TENANT = '0190f0a0-0000-7000-8000-0000000000c1';

interface TripFixture {
  tripId: string;
  pools: Record<string, string>;
}

/** Crea un viaje nuevo por prueba (con el rol de plataforma), con su inventario materializado. */
async function createTrip(
  platform: Pool,
  spec: {
    stops?: number;
    resources?: { code: string; kind: string; parent?: string }[];
    pools?: { code: string; dimension: string; capacity: number; used?: number[] }[];
  },
): Promise<TripFixture> {
  const stops = spec.stops ?? 4;
  const tripId = randomUUID();
  await platform.query('INSERT INTO inv_trips (id, tenant_id, code, stop_count) VALUES ($1, $2, $3, $4)', [
    tripId,
    TENANT,
    `T-${tripId.slice(0, 8)}`,
    stops,
  ]);
  const ids = new Map<string, string>();
  for (const r of spec.resources ?? []) {
    const id = randomUUID();
    ids.set(r.code, id);
    await platform.query(
      'INSERT INTO inv_trip_resources (id, tenant_id, trip_id, code, kind, parent_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, TENANT, tripId, r.code, r.kind, r.parent ? ids.get(r.parent) : null],
    );
  }
  const pools: Record<string, string> = {};
  for (const p of spec.pools ?? []) {
    const poolId = randomUUID();
    pools[p.dimension === 'PERSONS' ? p.code : `${p.code}:${p.dimension}`] = poolId;
    await platform.query(
      'INSERT INTO inv_pools (id, tenant_id, trip_id, code, dimension, capacity) VALUES ($1, $2, $3, $4, $5, $6)',
      [poolId, TENANT, tripId, p.code, p.dimension, p.capacity],
    );
    for (let seg = 0; seg < stops - 1; seg++) {
      await platform.query(
        'INSERT INTO inv_pool_segment_usage (tenant_id, pool_id, segment_seq, capacity, used) VALUES ($1, $2, $3, $4, $5)',
        [TENANT, poolId, seg, p.capacity, p.used?.[seg] ?? 0],
      );
    }
  }
  return { tripId, pools };
}

const request = (
  trip: TripFixture,
  from: number,
  to: number,
  extra: Partial<SaleRequest> = {},
): SaleRequest => ({
  tenantId: TENANT,
  tripId: trip.tripId,
  fromSeq: from,
  toSeq: to,
  holderId: randomUUID(),
  ...extra,
});

/** Ejecuta en paralelo y cuenta resultados por tipo. */
async function race(app: Pool, requests: SaleRequest[]) {
  const outcomes = await Promise.allSettled(requests.map((r) => sell(app, r)));
  const ok = outcomes.filter((o) => o.status === 'fulfilled').length;
  const rejected = outcomes
    .filter((o): o is PromiseRejectedResult => o.status === 'rejected')
    .map((o) => o.reason as Error);
  const unexpected = rejected.filter(
    (e) => !(e instanceof ResourceUnavailableError) && !(e instanceof CapacityExceededError),
  );
  return { ok, rejected, unexpected };
}

async function usage(platform: Pool, poolId: string): Promise<number[]> {
  const { rows } = await platform.query<{ used: string }>(
    'SELECT used FROM inv_pool_segment_usage WHERE pool_id = $1 ORDER BY segment_seq',
    [poolId],
  );
  return rows.map((r) => Number(r.used));
}

async function activeHolders(platform: Pool, tripId: string, code: string): Promise<string[]> {
  const { rows } = await platform.query<{ holder_id: string }>(
    `SELECT a.holder_id FROM inv_resource_allocations a JOIN inv_trip_resources r ON r.id = a.trip_resource_id
      WHERE r.trip_id = $1 AND r.code = $2 AND a.status <> 'RELEASED'`,
    [tripId, code],
  );
  return rows.map((r) => r.holder_id);
}

describe('PoC 2 · inventario por tramos y concurrencia (PostgreSQL real, rol yebo_app + RLS)', () => {
  let app: Pool;
  let platform: Pool;
  let owner: Pool;

  beforeAll(async () => {
    owner = testPool('owner', DB, 1);
    await owner.query(
      'TRUNCATE inv_pool_allocations, inv_pool_segment_usage, inv_pools, inv_resource_allocations, inv_trip_resources, inv_trips',
    );
    app = testPool('app', DB, 20);
    platform = testPool('platform', DB, 4);
  });

  afterEach(async () => {
    // Invariante global tras cada prueba: los contadores coinciden con las asignaciones activas.
    expect(await reconciliationViolations(platform)).toEqual([]);
  });

  afterAll(async () => {
    await Promise.all([app.end(), platform.end(), owner.end()]);
  });

  describe('recursos asignables (restricción de exclusión GIST)', () => {
    it('§6.1 · 50 ventas simultáneas del asiento 12A en [0,2): exactamente 1 éxito', async () => {
      const trip = await createTrip(platform, { resources: [{ code: '12A', kind: 'SEAT' }] });
      const result = await race(
        app,
        Array.from({ length: 50 }, () => request(trip, 0, 2, { resourceCodes: ['12A'] })),
      );
      expect(result.unexpected).toEqual([]);
      expect(result.ok).toBe(1);
      expect(await activeHolders(platform, trip.tripId, '12A')).toHaveLength(1);
    });

    it('§6.2 · ejemplo B: tramos contiguos [0,1) y [1,3) del mismo asiento → ambos se venden', async () => {
      const trip = await createTrip(platform, { resources: [{ code: '12A', kind: 'SEAT' }] });
      const result = await race(app, [
        request(trip, 0, 1, { resourceCodes: ['12A'] }),
        request(trip, 1, 3, { resourceCodes: ['12A'] }),
      ]);
      expect(result.ok).toBe(2);
    });

    it('§6.3 · tramos parcialmente superpuestos [0,2) y [1,3) concurrentes → 1 éxito (repetido 20 veces)', async () => {
      for (let i = 0; i < 20; i++) {
        const trip = await createTrip(platform, { resources: [{ code: '12A', kind: 'SEAT' }] });
        const result = await race(app, [
          request(trip, 0, 2, { resourceCodes: ['12A'] }),
          request(trip, 1, 3, { resourceCodes: ['12A'] }),
        ]);
        expect(result.unexpected).toEqual([]);
        expect(result.ok).toBe(1);
      }
    });

    it('tramos NO superpuestos [0,1), [1,2) y [2,3) simultáneos del mismo asiento → los 3 se venden (20 rondas)', async () => {
      for (let i = 0; i < 20; i++) {
        const trip = await createTrip(platform, { resources: [{ code: '12A', kind: 'SEAT' }] });
        const result = await race(app, [
          request(trip, 0, 1, { resourceCodes: ['12A'] }),
          request(trip, 1, 2, { resourceCodes: ['12A'] }),
          request(trip, 2, 3, { resourceCodes: ['12A'] }),
        ]);
        expect(result.rejected).toEqual([]);
        expect(result.ok).toBe(3);
      }
    });

    it('superpuestos y no superpuestos a la vez: [0,3) frente a [0,1), [1,2), [2,3) → o gana [0,3) solo, o ganan los 3 tramos (20 rondas)', async () => {
      for (let i = 0; i < 20; i++) {
        const trip = await createTrip(platform, { resources: [{ code: '12A', kind: 'SEAT' }] });
        const whole = request(trip, 0, 3, { resourceCodes: ['12A'] });
        const outcomes = await Promise.allSettled(
          [whole, ...[0, 1, 2].map((s) => request(trip, s, s + 1, { resourceCodes: ['12A'] }))].map((r) =>
            sell(app, r),
          ),
        );
        for (const o of outcomes) {
          if (o.status === 'rejected') expect(o.reason).toBeInstanceOf(ResourceUnavailableError);
        }
        const won = outcomes.map((o) => o.status === 'fulfilled');
        const holders = await activeHolders(platform, trip.tripId, '12A');
        if (won[0]) {
          expect(won).toEqual([true, false, false, false]);
          expect(holders).toEqual([whole.holderId]);
        } else {
          // Si [0,3) perdió, los tres tramos (que no se superponen entre sí) se vendieron.
          expect(won).toEqual([false, true, true, true]);
          expect(holders).toHaveLength(3);
        }
      }
    });

    /** Repite N colisiones simultáneas [0,2) frente a [1,3) del mismo asiento y clasifica cada rechazo. */
    async function collisions(rounds: number, serializeResourceContention: boolean) {
      const stats = {
        rounds,
        winners: 0,
        deadlocks: 0,
        unavailable: 0,
        other: [] as unknown[],
        maxRoundMs: 0,
      };
      for (let i = 0; i < rounds; i++) {
        const trip = await createTrip(platform, { resources: [{ code: '12A', kind: 'SEAT' }] });
        const started = performance.now();
        const outcomes = await Promise.allSettled([
          sell(app, request(trip, 0, 2, { resourceCodes: ['12A'], serializeResourceContention })),
          sell(app, request(trip, 1, 3, { resourceCodes: ['12A'], serializeResourceContention })),
        ]);
        stats.maxRoundMs = Math.max(stats.maxRoundMs, performance.now() - started);
        const winners = outcomes.filter((o) => o.status === 'fulfilled').length;
        expect(winners).toBeLessThanOrEqual(1); // nunca doble venta, en ningún diseño
        stats.winners += winners;
        for (const o of outcomes) {
          if (o.status !== 'rejected') continue;
          if ((o.reason as { code?: string }).code === '40P01') stats.deadlocks++;
          else if (o.reason instanceof ResourceUnavailableError) stats.unavailable++;
          else stats.other.push(o.reason);
        }
      }
      stats.maxRoundMs = Math.round(stats.maxRoundMs);
      return stats;
    }

    it('ADR-026 · 40 colisiones simultáneas con bloqueo ordenado: 1 venta y 1 ResourceUnavailableError por ronda, 0 interbloqueos', async () => {
      const stats = await collisions(40, true);
      console.warn(`[PoC-2] ADR-026 (bloqueo ordenado): ${JSON.stringify(stats)}`);
      expect(stats.other).toEqual([]);
      expect(stats.deadlocks).toBe(0);
      expect(stats.winners).toBe(40);
      expect(stats.unavailable).toBe(40);
    });

    it('referencia · las mismas 40 colisiones SIN bloqueo previo (diseño anterior a ADR-026): sin doble venta, pero con 40P01', async () => {
      const stats = await collisions(40, false);
      // Medición registrada en docs/development/phase-2-results.md. No se exige un número de interbloqueos:
      // depende de la planificación; esta prueba documenta por qué se adoptó ADR-026.
      console.warn(`[PoC-2] sin bloqueo previo: ${JSON.stringify(stats)}`);
      expect(stats.other).toEqual([]);
      expect(stats.deadlocks + stats.unavailable + stats.winners).toBe(80);
    });

    it('ADR-026 · mayor concurrencia: 300 ventas simultáneas (40 conexiones, 6 asientos, 5 tramos, 1–2 asientos en orden aleatorio, aforo de 4)', async () => {
      const seats = ['1A', '1B', '1C', '2A', '2B', '2C'];
      const CAPACITY = 4; // menor que los asientos: también se agota el aforo (CapacityExceededError)
      const trip = await createTrip(platform, {
        stops: 6,
        resources: seats.map((code) => ({ code, kind: 'SEAT' })),
        pools: [{ code: 'NAVE', dimension: 'PERSONS', capacity: CAPACITY }],
      });
      const poolId = trip.pools.NAVE ?? '';
      const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)] as T;
      const requests = Array.from({ length: 300 }, () => {
        const from = Math.floor(Math.random() * 5);
        const to = from + 1 + Math.floor(Math.random() * (5 - from));
        const first = pick(seats);
        const codes = Math.random() < 0.3 ? [first, pick(seats.filter((s) => s !== first))] : [first];
        return request(trip, from, to, {
          resourceCodes: codes,
          poolDemands: [{ poolId, quantity: codes.length }],
        });
      });
      const wide = testPool('app', DB, 40);
      const started = performance.now();
      let outcomes: PromiseSettledResult<unknown>[];
      try {
        outcomes = await Promise.allSettled(requests.map((r) => sell(wide, r)));
      } finally {
        await wide.end();
      }
      const elapsedMs = Math.round(performance.now() - started);

      // 1) Solo errores controlados de disponibilidad: ningún 40P01 ni error interno.
      const tally = { ok: 0, unavailable: 0, capacity: 0, other: [] as unknown[] };
      outcomes.forEach((o) => {
        if (o.status === 'fulfilled') tally.ok++;
        else if (o.reason instanceof ResourceUnavailableError) tally.unavailable++;
        else if (o.reason instanceof CapacityExceededError) tally.capacity++;
        else tally.other.push(o.reason);
      });
      console.warn(
        `[PoC-2] mayor concurrencia: ${JSON.stringify({ ...tally, other: tally.other.length, elapsedMs })}`,
      );
      expect(tally.other).toEqual([]);
      expect(tally.ok).toBeGreaterThan(0);

      // 2) Ningún asiento vendido dos veces en tramos superpuestos.
      const { rows: overlaps } = await platform.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM inv_resource_allocations a JOIN inv_resource_allocations b
            ON a.trip_resource_id = b.trip_resource_id AND a.id < b.id AND a.stop_range && b.stop_range
         WHERE a.trip_id = $1 AND a.status <> 'RELEASED' AND b.status <> 'RELEASED'`,
        [trip.tripId],
      );
      expect(overlaps[0]?.n).toBe(0);

      // 3) Lo vendido es exactamente lo confirmado: ni de más ni de menos.
      const sold = requests.filter((_, i) => outcomes[i]?.status === 'fulfilled');
      const { rows: allocated } = await platform.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM inv_resource_allocations WHERE trip_id = $1 AND status <> 'RELEASED'",
        [trip.tripId],
      );
      expect(allocated[0]?.n).toBe(sold.reduce((n, r) => n + (r.resourceCodes?.length ?? 0), 0));
      expect(Math.max(...(await usage(platform, poolId)))).toBeLessThanOrEqual(CAPACITY);

      // 4) Cada rechazo está justificado por el estado final (sin liberaciones, los conflictos persisten).
      const finalUsage = await usage(platform, poolId);
      const { rows: active } = await platform.query<{ code: string; lo: number; hi: number }>(
        `SELECT r.code, lower(a.stop_range) AS lo, upper(a.stop_range) AS hi
           FROM inv_resource_allocations a JOIN inv_trip_resources r ON r.id = a.trip_resource_id
          WHERE a.trip_id = $1 AND a.status <> 'RELEASED'`,
        [trip.tripId],
      );
      outcomes.forEach((o, i) => {
        const r = requests[i];
        if (!r || o.status !== 'rejected') return;
        if (o.reason instanceof ResourceUnavailableError) {
          const conflict = active.some(
            (a) => r.resourceCodes?.includes(a.code) && a.lo < r.toSeq && r.fromSeq < a.hi,
          );
          expect(conflict).toBe(true);
        } else {
          const qty = r.resourceCodes?.length ?? 0;
          const full = finalUsage.slice(r.fromSeq, r.toSeq).some((used) => used + qty > CAPACITY);
          expect(full).toBe(true);
        }
      });
    });

    it('ejemplo A · la segunda venta ESPERA a la primera y falla cuando esta confirma', async () => {
      const trip = await createTrip(platform, { resources: [{ code: '12A', kind: 'SEAT' }] });
      const t1 = await app.connect();
      try {
        await t1.query('BEGIN');
        await t1.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT]);
        await t1.query(
          `INSERT INTO inv_resource_allocations (id, tenant_id, trip_id, trip_resource_id, stop_range, status, holder_type, holder_id)
           SELECT gen_random_uuid(), $1, $2, id, int4range(0, 2), 'CONFIRMED', 'BOOKING_ITEM', gen_random_uuid()
             FROM inv_trip_resources WHERE trip_id = $2 AND code = '12A'`,
          [TENANT, trip.tripId],
        );
        let settled = false;
        const t2 = sell(app, request(trip, 1, 3, { resourceCodes: ['12A'] })).finally(() => {
          settled = true;
        });
        await new Promise((r) => setTimeout(r, 400));
        expect(settled).toBe(false); // T2 bloqueada por la fila no confirmada de T1
        await t1.query('COMMIT');
        await expect(t2).rejects.toBeInstanceOf(ResourceUnavailableError);
      } finally {
        t1.release();
      }
    });

    it('ejemplo A (variante) · si la primera se revierte, la segunda obtiene el asiento', async () => {
      const trip = await createTrip(platform, { resources: [{ code: '12A', kind: 'SEAT' }] });
      const t1 = await app.connect();
      try {
        await t1.query('BEGIN');
        await t1.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT]);
        await t1.query(
          `INSERT INTO inv_resource_allocations (id, tenant_id, trip_id, trip_resource_id, stop_range, status, holder_type, holder_id)
           SELECT gen_random_uuid(), $1, $2, id, int4range(0, 2), 'CONFIRMED', 'BOOKING_ITEM', gen_random_uuid()
             FROM inv_trip_resources WHERE trip_id = $2 AND code = '12A'`,
          [TENANT, trip.tripId],
        );
        const t2 = sell(app, request(trip, 1, 3, { resourceCodes: ['12A'] }));
        await new Promise((r) => setTimeout(r, 300));
        await t1.query('ROLLBACK');
        await expect(t2).resolves.toMatchObject({ resourceIds: [expect.any(String)] });
      } finally {
        t1.release();
      }
    });

    it('§6.7 · ejemplo C: una retención vencida se libera y el asiento se revende', async () => {
      const trip = await createTrip(platform, { resources: [{ code: '7B', kind: 'SEAT' }] });
      const expired = request(trip, 0, 3, {
        resourceCodes: ['7B'],
        status: 'HELD',
        holdExpiresAt: new Date(Date.now() - 60_000),
      });
      await sell(app, expired);
      const resale = request(trip, 0, 3, { resourceCodes: ['7B'] });
      await expect(sell(app, resale)).resolves.toBeDefined();
      expect(await activeHolders(platform, trip.tripId, '7B')).toEqual([resale.holderId]);
    });

    it('una retención vigente sí bloquea la reventa', async () => {
      const trip = await createTrip(platform, { resources: [{ code: '7C', kind: 'SEAT' }] });
      await sell(
        app,
        request(trip, 0, 3, {
          resourceCodes: ['7C'],
          status: 'HELD',
          holdExpiresAt: new Date(Date.now() + 600_000),
        }),
      );
      await expect(sell(app, request(trip, 2, 3, { resourceCodes: ['7C'] }))).rejects.toBeInstanceOf(
        ResourceUnavailableError,
      );
    });
  });

  describe('camarotes y camas (corrección R2, ejemplo D)', () => {
    const cabin = [
      { code: 'C3', kind: 'CABIN' },
      { code: 'C3-B1', kind: 'BED', parent: 'C3' },
      { code: 'C3-B2', kind: 'BED', parent: 'C3' },
      { code: 'C3-B3', kind: 'BED', parent: 'C3' },
      { code: 'C3-B4', kind: 'BED', parent: 'C3' },
    ];

    it('§6.4 · dos camas distintas del mismo camarote se venden a la vez (regresión del error R1)', async () => {
      const trip = await createTrip(platform, { resources: cabin });
      const result = await race(app, [
        request(trip, 0, 3, { resourceCodes: ['C3-B1'] }),
        request(trip, 0, 3, { resourceCodes: ['C3-B2'] }),
      ]);
      expect(result.ok).toBe(2);
    });

    it('§6.4 · camarote completo frente a 4 camas sueltas concurrentes: nunca una mezcla inválida (20 rondas)', async () => {
      for (let round = 0; round < 20; round++) {
        const trip = await createTrip(platform, { resources: cabin });
        const whole = request(trip, 0, 3, { resourceCodes: ['C3'] });
        const singles = ['C3-B1', 'C3-B2', 'C3-B3', 'C3-B4'].map((code) =>
          request(trip, 0, 3, { resourceCodes: [code] }),
        );
        const outcomes = await Promise.allSettled([sell(app, whole), ...singles.map((s) => sell(app, s))]);
        const unexpected = outcomes.filter(
          (o) => o.status === 'rejected' && !(o.reason instanceof ResourceUnavailableError),
        );
        expect(unexpected).toEqual([]);

        const holders = await Promise.all(
          ['C3-B1', 'C3-B2', 'C3-B3', 'C3-B4'].map((c) => activeHolders(platform, trip.tripId, c)),
        );
        for (const bedHolders of holders) expect(bedHolders.length).toBeLessThanOrEqual(1);
        if (outcomes[0]?.status === 'fulfilled') {
          // Si se vendió el camarote, TODAS sus camas pertenecen a esa venta.
          expect(holders.every((h) => h[0] === whole.holderId)).toBe(true);
        } else {
          // Si no, ninguna cama pertenece a la venta del camarote.
          expect(holders.flat()).not.toContain(whole.holderId);
        }
      }
    });

    it('no se vende un camarote "incompleto": si una cama ya está vendida, la venta completa se revierte', async () => {
      const trip = await createTrip(platform, { resources: cabin });
      await sell(app, request(trip, 2, 3, { resourceCodes: ['C3-B2'] }));
      const whole = request(trip, 0, 3, { resourceCodes: ['C3'] });
      await expect(sell(app, whole)).rejects.toBeInstanceOf(ResourceUnavailableError);
      for (const code of ['C3-B1', 'C3-B3', 'C3-B4']) {
        expect(await activeHolders(platform, trip.tripId, code)).toEqual([]);
      }
    });
  });

  describe('capacidades agregadas por tramo (bloqueo ordenado + CHECK)', () => {
    it('§6.5 · zona libre de 10 y 25 ventas concurrentes con tramos aleatorios: ningún tramo supera 10', async () => {
      const trip = await createTrip(platform, {
        pools: [{ code: 'FREE', dimension: 'PERSONS', capacity: 10 }],
      });
      const poolId = trip.pools.FREE!;
      const ranges = Array.from({ length: 25 }, (_, i) => {
        const from = i % 3;
        return [from, from + 1 + ((i * 7) % (3 - from))] as const;
      });
      const result = await race(
        app,
        ranges.map(([from, to]) => request(trip, from, to, { poolDemands: [{ poolId, quantity: 1 }] })),
      );
      expect(result.unexpected).toEqual([]);
      const used = await usage(platform, poolId);
      expect(Math.max(...used)).toBeLessThanOrEqual(10);
      expect(result.ok).toBeGreaterThan(0);
      expect(result.rejected.length).toBeGreaterThan(0);
    });

    it('ejemplo E · ocupación [9,9,4]: [0,2) y [1,3) compiten por el último lugar del tramo 1 → 1 éxito; [2,3) sigue libre', async () => {
      for (let i = 0; i < 10; i++) {
        const trip = await createTrip(platform, {
          pools: [{ code: 'FREE', dimension: 'PERSONS', capacity: 10, used: [9, 9, 4] }],
        });
        const poolId = trip.pools.FREE!;
        // Ocupación previa registrada como asignaciones reales para que la reconciliación cuadre.
        await platform.query(
          `INSERT INTO inv_pool_allocations (id, tenant_id, pool_id, stop_range, quantity, status, holder_type, holder_id)
           VALUES (gen_random_uuid(), $1, $2, int4range(0,2), 5, 'CONFIRMED', 'BOOKING_ITEM', gen_random_uuid()),
                  (gen_random_uuid(), $1, $2, int4range(0,3), 4, 'CONFIRMED', 'BOOKING_ITEM', gen_random_uuid())`,
          [TENANT, poolId],
        );
        const result = await race(app, [
          request(trip, 0, 2, { poolDemands: [{ poolId, quantity: 1 }] }),
          request(trip, 1, 3, { poolDemands: [{ poolId, quantity: 1 }] }),
        ]);
        expect(result.unexpected).toEqual([]);
        expect(result.ok).toBe(1);
        expect(result.rejected[0]).toMatchObject({ segmentSeq: 1 });
        await expect(
          sell(app, request(trip, 2, 3, { poolDemands: [{ poolId, quantity: 1 }] })),
        ).resolves.toBeDefined();
      }
    });

    it('§6.6 · ejemplo F: 30 traslados concurrentes peso+volumen en orden inverso no producen deadlocks', async () => {
      const trip = await createTrip(platform, {
        pools: [
          { code: 'HOLD', dimension: 'WEIGHT_KG', capacity: 2000 },
          { code: 'HOLD', dimension: 'VOLUME_M3', capacity: 12 },
        ],
      });
      const weightId = trip.pools['HOLD:WEIGHT_KG']!;
      const volumeId = trip.pools['HOLD:VOLUME_M3']!;
      const ids = [weightId, volumeId];
      const requests = Array.from({ length: 30 }, (_, i) => {
        const demands = [
          { poolId: weightId, quantity: 150 },
          { poolId: volumeId, quantity: 0.9 },
        ];
        if (i % 2) demands.reverse();
        return request(trip, i % 3, 3, { holderType: 'TRANSFER', poolDemands: demands });
      });
      const result = await race(app, requests);
      expect(result.unexpected).toEqual([]); // sin 40P01 (deadlock) ni otros errores
      for (const id of ids) {
        const used = await usage(platform, id);
        const { rows } = await platform.query<{ capacity: string }>(
          'SELECT capacity FROM inv_pools WHERE id = $1',
          [id],
        );
        expect(Math.max(...used)).toBeLessThanOrEqual(Number(rows[0]!.capacity));
      }
    });

    it('el CHECK es la red final: ni siquiera un UPDATE directo puede superar la capacidad', async () => {
      const trip = await createTrip(platform, {
        pools: [{ code: 'FREE', dimension: 'PERSONS', capacity: 10 }],
      });
      await expect(
        platform.query('UPDATE inv_pool_segment_usage SET used = 11 WHERE pool_id = $1 AND segment_seq = 0', [
          trip.pools.FREE,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('liberar una venta devuelve exactamente la capacidad y el recurso', async () => {
      const trip = await createTrip(platform, {
        resources: [{ code: '3A', kind: 'SEAT' }],
        pools: [{ code: 'FREE', dimension: 'PERSONS', capacity: 10 }],
      });
      const poolId = trip.pools.FREE!;
      const sale = request(trip, 0, 2, { resourceCodes: ['3A'], poolDemands: [{ poolId, quantity: 3 }] });
      await sell(app, sale);
      expect(await usage(platform, poolId)).toEqual([3, 3, 0]);
      await release(app, TENANT, sale.holderId);
      expect(await usage(platform, poolId)).toEqual([0, 0, 0]);
      await expect(sell(app, request(trip, 1, 3, { resourceCodes: ['3A'] }))).resolves.toBeDefined();
    });
  });

  describe('ventas combinadas (atomicidad)', () => {
    it('ejemplo H · aforo de la nave lleno: aunque el asiento esté libre, no se vende nada', async () => {
      const trip = await createTrip(platform, {
        resources: [{ code: '1A', kind: 'SEAT' }],
        pools: [{ code: 'VESSEL', dimension: 'PERSONS', capacity: 1 }],
      });
      const vessel = trip.pools.VESSEL!;
      await sell(app, request(trip, 0, 3, { poolDemands: [{ poolId: vessel, quantity: 1 }] }));
      await expect(
        sell(
          app,
          request(trip, 0, 3, { resourceCodes: ['1A'], poolDemands: [{ poolId: vessel, quantity: 1 }] }),
        ),
      ).rejects.toBeInstanceOf(CapacityExceededError);
      expect(await activeHolders(platform, trip.tripId, '1A')).toEqual([]); // el asiento NO quedó asignado
    });

    it('ejemplo G · camión en cubierta: espacio V3 + peso + metros lineales en una transacción', async () => {
      const trip = await createTrip(platform, {
        resources: ['V1', 'V2', 'V3', 'V4'].map((code) => ({ code, kind: 'VEHICLE_SLOT' })),
        pools: [
          { code: 'DECK', dimension: 'WEIGHT_KG', capacity: 60000 },
          { code: 'DECK', dimension: 'LINEAR_M', capacity: 40 },
        ],
      });
      const weight = trip.pools['DECK:WEIGHT_KG']!;
      const linear = trip.pools['DECK:LINEAR_M']!;
      const truck = (slot: string, kg: number) =>
        request(trip, 0, 3, {
          holderType: 'CARGO_ASSIGNMENT',
          resourceCodes: [slot],
          poolDemands: [
            { poolId: weight, quantity: kg },
            { poolId: linear, quantity: 9.5 },
          ],
        });
      await expect(sell(app, truck('V3', 18000))).resolves.toBeDefined();
      await expect(sell(app, truck('V3', 5000))).rejects.toBeInstanceOf(ResourceUnavailableError);
      await expect(sell(app, truck('V1', 18000))).resolves.toBeDefined();
      await expect(sell(app, truck('V2', 30000))).rejects.toBeInstanceOf(CapacityExceededError); // 66 t > 60 t
      expect(await activeHolders(platform, trip.tripId, 'V2')).toEqual([]);
    });
  });

  it('RLS: otro tenant no ve ni puede vender el inventario de este viaje', async () => {
    const trip = await createTrip(platform, { resources: [{ code: '9Z', kind: 'SEAT' }] });
    const other = '0190f0a0-0000-7000-8000-0000000000c2';
    await expect(
      sell(app, { ...request(trip, 0, 1, { resourceCodes: ['9Z'] }), tenantId: other }),
    ).rejects.toThrow('Viaje inexistente');
  });
});
