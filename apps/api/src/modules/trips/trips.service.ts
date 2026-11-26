import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  LayoutDocumentSchema,
  TRIP_MAX_DAYS_AHEAD,
  deriveInventory,
  tripCode,
  type CreateTripRequest,
  type Trip,
  type TripInventory,
  type TripsQuery,
  type UpdateTripRequest,
} from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { FleetContext } from '../fleet/fleet-context';
import { addDays, instantToLocal, localToInstant } from './local-time';

const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, 400);
const conflict = (message: string) => new AppError('CONFLICT', message, 409);

const DEFAULT_TIMEZONE = 'America/Lima';
const VEHICLE_STATUS_NAME: Record<string, string> = {
  MAINTENANCE: 'en mantenimiento',
  OUT_OF_SERVICE: 'fuera de servicio',
  RETIRED: 'retirada',
};

const TRIP_INCLUDE = {
  route: { select: { code: true, name: true, modality: true } },
  vehicle: { select: { id: true, code: true, name: true } },
  version: { select: { version: true, layoutId: true, layout: { select: { name: true } } } },
  stops: { orderBy: { seq: 'asc' }, include: { location: { select: { name: true } } } },
  pools: {
    orderBy: [{ scope: 'asc' }, { zoneCode: 'asc' }, { dimension: 'asc' }],
    include: { _count: { select: { segments: true } } },
  },
  _count: { select: { resources: true } },
} as const satisfies Prisma.TripInclude;
type TripRow = Prisma.TripGetPayload<{ include: typeof TRIP_INCLUDE }>;

export type Unit = { vehicleId: string | null; layoutVersionId: string | null };

/**
 * Viajes de la empresa del host (Fase 7.3a; F7-Q3, F7-Q4 y F7-Q6). Todo con `yebo_app` y el tenant del contexto (RLS
 * forzado): un viaje, una ruta, un vehículo o un plano de otra empresa no existe.
 * - Las horas llegan y salen en la hora local de la empresa; se guardan como instantes (`timestamptz`).
 * - Crear un viaje copia las paradas de la ruta (bloqueada en modo compartido) con sus horas planificadas.
 * - Unidad y plano: un vehículo no retirado de la modalidad de la ruta, libre en ese horario, y el plano elegido (una
 *   versión publicada compatible) o el que tiene asignado el día de la salida. Fijarlos materializa el inventario con
 *   `deriveInventory`; cambiarlos lo reemplaza (solo con el viaje planificado).
 * - Abrir la venta crea un contador por pool y tramo; volver a planificar los borra (sin ocupación). La base comprueba
 *   la coherencia al confirmar y es la garantía final de todo lo anterior.
 */
@Injectable()
export class TripsService {
  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly ctx: FleetContext,
  ) {}

  async list(q: TripsQuery): Promise<Trip[]> {
    const tz = this.tz();
    const from = localToInstant(`${q.from}T00:00`, tz);
    const to = localToInstant(`${addDays(q.to, 1)}T00:00`, tz);
    const rows = await this.db.transaction(async (tx) => ({
      trips: await tx.trip.findMany({
        where: {
          plannedDepartureAt: { gte: from, lt: to },
          ...(q.routeId ? { routeId: q.routeId } : {}),
          ...(q.status ? { status: q.status } : {}),
        },
        orderBy: [{ plannedDepartureAt: 'asc' }, { code: 'asc' }],
        include: TRIP_INCLUDE,
      }),
    }));
    const sellable = await this.sellableCounts(rows.trips.map((t) => t.id));
    return rows.trips.map((t) => toTrip(t, tz, sellable.get(t.id) ?? 0));
  }

  async get(id: string): Promise<Trip> {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    return this.db.transaction((tx) => this.detail(tx, id));
  }

  async inventory(id: string): Promise<TripInventory> {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    return this.db.transaction(async (tx) => {
      const trip = await tx.trip.findFirst({
        where: { id },
        select: {
          id: true,
          stops: { orderBy: { seq: 'asc' }, select: { seq: true, location: { select: { name: true } } } },
          resources: { orderBy: { code: 'asc' }, include: { parent: { select: { code: true } } } },
          pools: {
            orderBy: [{ scope: 'asc' }, { zoneCode: 'asc' }, { dimension: 'asc' }],
            include: { segments: { orderBy: { segmentSeq: 'asc' } } },
          },
        },
      });
      if (!trip) throw NOT_FOUND();
      return {
        tripId: trip.id,
        segments: trip.stops.slice(0, -1).map((s, i) => ({
          seq: s.seq,
          from: s.location.name,
          to: trip.stops[i + 1]?.location.name ?? '',
        })),
        resources: trip.resources.map((r) => ({
          code: r.code,
          kind: r.kind,
          zoneCode: r.zoneCode,
          parentCode: r.parent?.code ?? null,
          priceClassCode: r.priceClassCode,
          capacity: r.capacity,
          isSellable: r.isSellable,
          sellableAsUnit: r.sellableAsUnit,
        })),
        pools: trip.pools.map((p) => ({
          id: p.id,
          scope: p.scope,
          zoneCode: p.zoneCode,
          dimension: p.dimension,
          capacity: Number(p.capacity),
          usage: p.segments.map((u) => ({
            seq: u.segmentSeq,
            capacity: Number(u.capacity),
            used: Number(u.used),
          })),
        })),
      };
    });
  }

  /** Viaje puntual (ON_DEMAND): copia las paradas de la ruta y, si hay unidad con plano, materializa su inventario. */
  async create(input: CreateTripRequest): Promise<Trip> {
    const tz = this.tz();
    try {
      return await this.db.transaction(async (tx) => {
        const route = await this.lockRoute(tx, input.routeId);
        if (route.archived) throw conflict('La ruta está archivada: restáurala antes de crear viajes');
        const { departure, arrival } = this.times(input.departureLocal, route.stops, tz);
        const unit = await this.resolveUnit(
          tx,
          route.modality,
          input,
          input.departureLocal,
          departure,
          arrival,
          null,
        );
        await this.assertRouteSlot(tx, input.routeId, departure, null);
        const tripId = await this.insertTrip(tx, input.routeId, route, {
          departureLocal: input.departureLocal,
          departure,
          arrival,
          unit,
          minPassengers: input.minPassengers,
          confirmationDeadline: deadline(input.confirmationDeadlineLocal, tz),
          schedule: null,
        });
        return this.detail(tx, tripId);
      });
    } catch (e) {
      throw dbConflict(e) ?? e;
    }
  }

  /** Viaje planificado: mueve la salida (y las horas de sus paradas), cambia la unidad o el plano y el mínimo. */
  async update(id: string, input: UpdateTripRequest): Promise<Trip> {
    const tz = this.tz();
    try {
      return await this.db.transaction(async (tx) => {
        const current = await this.lockTrip(tx, id);
        if (current.status !== 'PLANNED') throw conflict('Solo se edita un viaje planificado');
        const route = await tx.route.findFirstOrThrow({
          where: { id: current.routeId },
          select: { code: true, modality: true },
        });
        const departure = this.futureDeparture(input.departureLocal, tz);
        const delta = departure.getTime() - current.plannedDepartureAt.getTime();
        const arrival = new Date(current.plannedArrivalAt.getTime() + delta);
        const unit = await this.resolveUnit(
          tx,
          route.modality,
          input,
          input.departureLocal,
          departure,
          arrival,
          id,
        );
        await this.assertRouteSlot(tx, current.routeId, departure, id);
        const code =
          delta === 0
            ? current.code
            : await this.freeCode(tx, tripCode(route.code, input.departureLocal), id);
        if (delta !== 0) {
          await tx.$executeRaw`
            UPDATE trip_stops SET planned_arrival_at = planned_arrival_at + ${delta} * interval '1 millisecond',
                                  planned_departure_at = planned_departure_at + ${delta} * interval '1 millisecond'
             WHERE trip_id = ${id}::uuid`;
        }
        await tx.trip.update({
          where: { id },
          data: {
            code,
            vehicleId: unit.vehicleId,
            layoutVersionId: unit.layoutVersionId,
            minPassengers: input.minPassengers,
            confirmationDeadline: deadline(input.confirmationDeadlineLocal, tz),
            plannedDepartureAt: departure,
            plannedArrivalAt: arrival,
          },
        });
        if (unit.layoutVersionId !== current.layoutVersionId) {
          // Con ocupación en su historia (aunque esté liberada), el inventario no se reemplaza: cambiar de unidad con
          // ocupación es el flujo trip_vehicle_changes (F7-Q3, Fase 8).
          const history =
            (await tx.resourceAllocation.count({ where: { tripId: id } })) +
            (await tx.poolAllocation.count({ where: { pool: { tripId: id } } }));
          if (history > 0) throw conflict('El viaje ya tuvo ocupación: su unidad y su plano no cambian');
          await this.clearInventory(tx, id);
          if (unit.layoutVersionId) await this.materialize(tx, id, unit.layoutVersionId);
        }
        return this.detail(tx, id);
      });
    } catch (e) {
      throw dbConflict(e) ?? e;
    }
  }

  /** PLANNED → OPEN_FOR_SALE: con unidad activa y plano, antes de la salida; crea un contador por pool y tramo. */
  async open(id: string): Promise<Trip> {
    return this.db.transaction(async (tx) => {
      const trip = await this.lockTrip(tx, id);
      if (trip.status === 'OPEN_FOR_SALE') throw conflict('El viaje ya está a la venta');
      if (trip.status !== 'PLANNED') throw conflict('Solo se abre a la venta un viaje planificado');
      if (!trip.layoutVersionId || !trip.vehicleId) {
        throw invalid('Asigna una unidad con plano antes de abrir la venta');
      }
      if (trip.plannedDepartureAt <= this.ctx.now()) throw conflict('El viaje ya salió');
      const vehicle = await tx.vehicle.findFirstOrThrow({
        where: { id: trip.vehicleId },
        select: { code: true, status: true },
      });
      if (vehicle.status !== 'ACTIVE') {
        throw conflict(`La unidad ${vehicle.code} está ${VEHICLE_STATUS_NAME[vehicle.status] ?? 'inactiva'}`);
      }
      const route = await tx.route.findFirstOrThrow({
        where: { id: trip.routeId },
        select: { archivedAt: true },
      });
      if (route.archivedAt) throw conflict('La ruta está archivada');
      const actor = this.ctx.actor();
      await tx.trip.update({
        where: { id },
        data: {
          status: 'OPEN_FOR_SALE',
          openedAt: this.ctx.now(),
          openedByKind: actor.kind,
          openedById: actor.id,
        },
      });
      // Un contador por pool y tramo: con n paradas, los tramos 0 … n-2.
      const segments = (await tx.tripStop.count({ where: { tripId: id } })) - 1;
      await tx.$executeRaw`
        INSERT INTO trip_pool_segment_usage (tenant_id, pool_id, segment_seq, capacity)
        SELECT p.tenant_id, p.id, s.seq, p.capacity
          FROM trip_capacity_pools p CROSS JOIN generate_series(0, ${segments}::int - 1) AS s(seq)
         WHERE p.trip_id = ${id}::uuid`;
      return this.detail(tx, id);
    });
  }

  /** OPEN_FOR_SALE → PLANNED, sin ocupación: borra los contadores por tramo. */
  async backToPlanned(id: string): Promise<Trip> {
    return this.db.transaction(async (tx) => {
      const trip = await this.lockTrip(tx, id);
      if (trip.status !== 'OPEN_FOR_SALE') throw conflict('Solo vuelve a planificado un viaje a la venta');
      await this.assertNoOccupancy(tx, id);
      await tx.trip.update({
        where: { id },
        data: { status: 'PLANNED', openedAt: null, openedByKind: null, openedById: null },
      });
      await tx.tripPoolSegmentUsage.deleteMany({ where: { pool: { tripId: id } } });
      return this.detail(tx, id);
    });
  }

  /** PLANNED u OPEN_FOR_SALE → CANCELLED, con motivo y sin ocupación. Es definitivo. */
  async cancel(id: string, reason: string): Promise<Trip> {
    return this.db.transaction(async (tx) => {
      const trip = await this.lockTrip(tx, id);
      if (trip.status === 'CANCELLED') throw conflict('El viaje ya está cancelado');
      if (trip.status !== 'PLANNED' && trip.status !== 'OPEN_FOR_SALE') {
        throw conflict('Este viaje ya no se puede cancelar');
      }
      await this.assertNoOccupancy(tx, id);
      const actor = this.ctx.actor();
      await tx.trip.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelReason: reason,
          cancelledAt: this.ctx.now(),
          cancelledByKind: actor.kind,
          cancelledById: actor.id,
        },
      });
      return this.detail(tx, id);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** Salida en el futuro y no más allá de TRIP_MAX_DAYS_AHEAD días. */
  private futureDeparture(local: string, tz: string): Date {
    const departure = localToInstant(local, tz);
    if (departure <= this.ctx.now()) throw invalid('La salida es posterior a este momento');
    if (local.slice(0, 10) > addDays(this.ctx.today(), TRIP_MAX_DAYS_AHEAD)) {
      throw invalid(`La salida es como mucho a ${TRIP_MAX_DAYS_AHEAD} días`);
    }
    return departure;
  }

  private times(local: string, stops: RouteStopRow[], tz: string): { departure: Date; arrival: Date } {
    const departure = this.futureDeparture(local, tz);
    const last = stops[stops.length - 1];
    return { departure, arrival: addMinutes(departure, last?.offsetMinutes ?? 0) };
  }

  /**
   * Unidad y plano del viaje. Sin vehículo, ninguno. Con vehículo: no retirado, de la modalidad de la ruta y libre en
   * ese horario; el plano elegido (versión publicada, del mismo tipo de vehículo) o el asignado el día de la salida.
   */
  async resolveUnit(
    tx: Tx,
    modality: 'LAND' | 'RIVER',
    input: Pick<CreateTripRequest, 'vehicleId' | 'layout'>,
    departureLocal: string,
    departure: Date,
    arrival: Date,
    tripId: string | null,
  ): Promise<Unit> {
    if (!input.vehicleId) return { vehicleId: null, layoutVersionId: null };
    const vehicle = await tx.vehicle.findFirst({
      where: { id: input.vehicleId },
      select: { id: true, code: true, modality: true, status: true, vehicleTypeId: true },
    });
    if (!vehicle) throw invalid('La unidad no es de la empresa');
    if (vehicle.status === 'RETIRED') throw invalid(`La unidad ${vehicle.code} está retirada`);
    if (vehicle.modality !== modality)
      throw invalid(`La unidad ${vehicle.code} es de otra modalidad que la ruta`);
    const [busy] = await tx.$queryRaw<{ code: string }[]>`
      SELECT code FROM trips
       WHERE vehicle_id = ${vehicle.id}::uuid AND status <> 'CANCELLED'
         AND (${tripId}::uuid IS NULL OR id <> ${tripId}::uuid)
         AND tstzrange(planned_departure_at, planned_arrival_at, '[)') && tstzrange(${departure}, ${arrival}, '[)')
       ORDER BY planned_departure_at LIMIT 1`;
    if (busy) throw conflict(`La unidad ${vehicle.code} ya está en el viaje ${busy.code} en ese horario`);

    if (input.layout) {
      const version = await tx.layoutVersion.findFirst({
        where: { layoutId: input.layout.layoutId, version: input.layout.version },
        select: {
          id: true,
          status: true,
          layout: { select: { modality: true, vehicleTypeId: true, archivedAt: true } },
        },
      });
      if (!version) throw invalid('Esa versión del plano no existe');
      if (version.status !== 'PUBLISHED') throw invalid('Solo se usa una versión publicada del plano');
      if (version.layout.archivedAt) throw invalid('El plano está archivado');
      if (version.layout.modality !== vehicle.modality)
        throw invalid('El plano es de otra modalidad que la unidad');
      if (version.layout.vehicleTypeId && version.layout.vehicleTypeId !== vehicle.vehicleTypeId) {
        throw invalid('El plano es para otro tipo de vehículo');
      }
      return { vehicleId: vehicle.id, layoutVersionId: version.id };
    }
    const date = new Date(`${departureLocal.slice(0, 10)}T00:00:00Z`);
    const assigned = await tx.vehicleLayoutAssignment.findFirst({
      where: {
        vehicleId: vehicle.id,
        validFrom: { lte: date },
        OR: [{ validTo: null }, { validTo: { gt: date } }],
      },
      select: { layoutVersionId: true },
    });
    return { vehicleId: vehicle.id, layoutVersionId: assigned?.layoutVersionId ?? null };
  }

  /**
   * Inserta el viaje con sus paradas copiadas de la ruta (horas desde la salida) y, si hay plano, su inventario. Lo usan
   * el viaje puntual y la generación de las programaciones (7.3b): las comprobaciones van antes.
   */
  async insertTrip(
    tx: Tx,
    routeId: string,
    route: LockedRoute,
    t: {
      departureLocal: string;
      departure: Date;
      arrival: Date;
      unit: Unit;
      minPassengers: number | null;
      confirmationDeadline: Date | null;
      schedule: { id: string; date: string } | null;
    },
  ): Promise<string> {
    const tenantId = this.ctx.tenantId();
    const code = await this.freeCode(tx, tripCode(route.code, t.departureLocal), null);
    const trip = await tx.trip.create({
      data: {
        tenantId,
        code,
        routeId,
        departureKind: t.schedule ? 'SCHEDULED' : 'ON_DEMAND',
        scheduleId: t.schedule?.id ?? null,
        departureDate: t.schedule ? new Date(`${t.schedule.date}T00:00:00Z`) : null,
        vehicleId: t.unit.vehicleId,
        layoutVersionId: t.unit.layoutVersionId,
        minPassengers: t.minPassengers,
        confirmationDeadline: t.confirmationDeadline,
        plannedDepartureAt: t.departure,
        plannedArrivalAt: t.arrival,
      },
      select: { id: true },
    });
    await tx.tripStop.createMany({
      data: route.stops.map((s, i) => ({
        tenantId,
        tripId: trip.id,
        seq: s.seq,
        locationId: s.locationId,
        plannedArrivalAt: i === 0 ? null : addMinutes(t.departure, s.offsetMinutes),
        plannedDepartureAt:
          i === route.stops.length - 1 ? null : addMinutes(t.departure, s.offsetMinutes + s.dwellMinutes),
        allowsBoarding: s.allowsBoarding,
        allowsAlighting: s.allowsAlighting,
      })),
    });
    if (t.unit.layoutVersionId) await this.materialize(tx, trip.id, t.unit.layoutVersionId);
    return trip.id;
  }

  /** Recursos y pools del viaje desde la versión del plano (deriveInventory), con los ids de sus elementos. */
  private async materialize(tx: Tx, tripId: string, layoutVersionId: string): Promise<void> {
    const tenantId = this.ctx.tenantId();
    const version = await tx.layoutVersion.findFirstOrThrow({
      where: { id: layoutVersionId },
      select: { document: true, elements: { select: { id: true, code: true } } },
    });
    const inventory = deriveInventory(LayoutDocumentSchema.parse(version.document));
    const elementIds = new Map(version.elements.map((e) => [e.code, e.id]));
    const ids = new Map(inventory.resources.map((r) => [r.code, randomUUID()]));
    if (inventory.resources.length > 0) {
      await tx.tripResource.createMany({
        data: inventory.resources.map((r) => ({
          id: ids.get(r.code) as string,
          tenantId,
          tripId,
          layoutElementId: elementIds.get(r.code) as string,
          parentTripResourceId: r.parentCode ? (ids.get(r.parentCode) ?? null) : null,
          code: r.code,
          kind: r.kind as 'SEAT' | 'BED' | 'CABIN' | 'VEHICLE_SLOT',
          zoneCode: r.zoneCode,
          priceClassCode: r.priceClassCode,
          capacity: r.capacity,
          isSellable: r.isSellable,
          sellableAsUnit: r.sellableAsUnit,
        })),
      });
    }
    if (inventory.pools.length > 0) {
      await tx.tripCapacityPool.createMany({
        data: inventory.pools.map((p) => ({
          tenantId,
          tripId,
          scope: p.scope,
          zoneCode: p.zoneCode,
          dimension: p.dimension,
          capacity: p.capacity,
        })),
      });
    }
  }

  private async clearInventory(tx: Tx, tripId: string): Promise<void> {
    await tx.tripResource.deleteMany({ where: { tripId, parentTripResourceId: { not: null } } });
    await tx.tripResource.deleteMany({ where: { tripId } });
    await tx.tripCapacityPool.deleteMany({ where: { tripId } });
  }

  /** Sin ocupación en ningún tramo (7.4 sumará las asignaciones de recursos y los bloqueos). */
  /** Sin ocupación: ningún contador con uso ni asignación de recursos sin liberar (bloqueos o, en la Fase 8, ventas). */
  private async assertNoOccupancy(tx: Tx, tripId: string): Promise<void> {
    const used = await tx.tripPoolSegmentUsage.count({ where: { pool: { tripId }, used: { gt: 0 } } });
    const held = await tx.resourceAllocation.count({ where: { tripId, status: { not: 'RELEASED' } } });
    if (used > 0 || held > 0) throw conflict('El viaje tiene ocupación (bloqueos o ventas): libérala antes');
  }

  /** Una ruta no sale dos veces a la misma hora (salvo viajes cancelados). */
  async assertRouteSlot(tx: Tx, routeId: string, departure: Date, tripId: string | null): Promise<void> {
    const clash = await tx.trip.findFirst({
      where: {
        routeId,
        plannedDepartureAt: departure,
        status: { not: 'CANCELLED' },
        ...(tripId ? { id: { not: tripId } } : {}),
      },
      select: { code: true },
    });
    if (clash) throw conflict(`La ruta ya tiene el viaje ${clash.code} a esa hora`);
  }

  /** El código base o, si ya lo usa otro viaje (cancelado), con `-2`, `-3`… */
  private async freeCode(tx: Tx, base: string, tripId: string | null): Promise<string> {
    const taken = new Set(
      (
        await tx.trip.findMany({
          where: { code: { startsWith: base }, ...(tripId ? { id: { not: tripId } } : {}) },
          select: { code: true },
        })
      ).map((t) => t.code),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  async lockRoute(tx: Tx, id: string): Promise<LockedRoute> {
    if (!UUID.safeParse(id).success) throw invalid('La ruta no es de la empresa');
    const [locked] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id::text FROM routes WHERE id = ${id}::uuid FOR SHARE`;
    if (!locked) throw invalid('La ruta no es de la empresa');
    const route = await tx.route.findFirstOrThrow({
      where: { id },
      select: {
        code: true,
        modality: true,
        archivedAt: true,
        stops: {
          orderBy: { seq: 'asc' },
          select: {
            seq: true,
            locationId: true,
            offsetMinutes: true,
            dwellMinutes: true,
            allowsBoarding: true,
            allowsAlighting: true,
          },
        },
      },
    });
    return {
      code: route.code,
      modality: route.modality,
      archived: route.archivedAt !== null,
      stops: route.stops,
    };
  }

  private async lockTrip(tx: Tx, id: string) {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const [locked] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id::text FROM trips WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked) throw NOT_FOUND();
    return tx.trip.findFirstOrThrow({
      where: { id },
      select: {
        code: true,
        routeId: true,
        status: true,
        vehicleId: true,
        layoutVersionId: true,
        plannedDepartureAt: true,
        plannedArrivalAt: true,
      },
    });
  }

  private async detail(tx: Tx, id: string): Promise<Trip> {
    const row = await tx.trip.findFirst({ where: { id }, include: TRIP_INCLUDE });
    if (!row) throw NOT_FOUND();
    const sellable = await tx.tripResource.count({ where: { tripId: id, isSellable: true } });
    return toTrip(row, this.tz(), sellable);
  }

  private async sellableCounts(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.transaction((tx) =>
      tx.tripResource.groupBy({
        by: ['tripId'],
        where: { tripId: { in: ids }, isSellable: true },
        _count: true,
      }),
    );
    return new Map(rows.map((r) => [r.tripId, r._count]));
  }

  private tz(): string {
    return this.cls.get('tenant')?.timezone ?? DEFAULT_TIMEZONE;
  }
}

export type LockedRoute = {
  code: string;
  modality: 'LAND' | 'RIVER';
  archived: boolean;
  stops: RouteStopRow[];
};
export type Tx = Parameters<Parameters<TenantDbService['transaction']>[0]>[0];

type RouteStopRow = {
  seq: number;
  locationId: string;
  offsetMinutes: number;
  dwellMinutes: number;
  allowsBoarding: boolean;
  allowsAlighting: boolean;
};

const addMinutes = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);

const deadline = (local: string | null, tz: string) => (local === null ? null : localToInstant(local, tz));

function toTrip(r: TripRow, tz: string, sellable: number): Trip {
  const local = (d: Date | null) => (d === null ? null : instantToLocal(d, tz));
  return {
    id: r.id,
    code: r.code,
    routeId: r.routeId,
    routeCode: r.route.code,
    routeName: r.route.name,
    modality: r.route.modality,
    departureKind: r.departureKind,
    serviceMode: r.serviceMode,
    status: r.status,
    departureLocal: instantToLocal(r.plannedDepartureAt, tz),
    arrivalLocal: instantToLocal(r.plannedArrivalAt, tz),
    plannedDepartureAt: r.plannedDepartureAt.toISOString(),
    plannedArrivalAt: r.plannedArrivalAt.toISOString(),
    vehicle: r.vehicle,
    layout: r.version
      ? { layoutId: r.version.layoutId, name: r.version.layout.name, version: r.version.version }
      : null,
    minPassengers: r.minPassengers,
    confirmationDeadlineLocal: local(r.confirmationDeadline),
    stops: r.stops.map((s) => ({
      seq: s.seq,
      locationId: s.locationId,
      locationName: s.location.name,
      arrivalLocal: local(s.plannedArrivalAt),
      departureLocal: local(s.plannedDepartureAt),
      allowsBoarding: s.allowsBoarding,
      allowsAlighting: s.allowsAlighting,
    })),
    inventory: r.layoutVersionId
      ? {
          resources: r._count.resources,
          sellableResources: sellable,
          pools: r.pools.map((p) => ({
            id: p.id,
            scope: p.scope,
            zoneCode: p.zoneCode,
            dimension: p.dimension,
            capacity: Number(p.capacity),
          })),
          segmentRows: r.pools.reduce((n, p) => n + p._count.segments, 0),
        }
      : null,
    openedAt: r.openedAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
  };
}

/** Lo que la base rechaza por concurrencia (la API lo comprueba antes): 409. */
function dbConflict(e: unknown): AppError | null {
  const text =
    e instanceof Error ? `${e.message} ${JSON.stringify((e as { meta?: unknown }).meta ?? {})}` : '';
  if (/23P01|trips_vehicle_no_overlap/i.test(text))
    return conflict('La unidad ya está en otro viaje en ese horario');
  if (/trips_route_departure_key/.test(text)) return conflict('La ruta ya tiene un viaje a esa hora');
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    return conflict('Ya existe un viaje con ese código');
  }
  return null;
}
