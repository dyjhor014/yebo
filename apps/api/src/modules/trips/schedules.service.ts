import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  SCHEDULE_HORIZON_DAYS,
  fromRRule,
  occursOn,
  toRRule,
  type CreateScheduleRequest,
  type GenerateScheduleResponse,
  type Schedule,
  type UpdateScheduleRequest,
} from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { FleetContext } from '../fleet/fleet-context';
import { addDays, localToInstant } from './local-time';
import { TripsService, type Tx } from './trips.service';

const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, 400);
const conflict = (message: string) => new AppError('CONFLICT', message, 409);
const DEFAULT_TIMEZONE = 'America/Lima';

const day = (d: string) => new Date(`${d}T00:00:00Z`);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const SCHEDULE_INCLUDE = {
  route: { select: { code: true, name: true } },
  vehicle: { select: { id: true, code: true, name: true } },
  version: { select: { version: true, layoutId: true, layout: { select: { name: true } } } },
} as const satisfies Prisma.ScheduleInclude;
type ScheduleRow = Prisma.ScheduleGetPayload<{ include: typeof SCHEDULE_INCLUDE }>;

/**
 * Programaciones de la empresa del host (Fase 7.3b; F7-Q2). Todo con `yebo_app` y el tenant del contexto (RLS forzado).
 * - La unidad y el plano por defecto se validan como en un viaje (modalidad de la ruta, versión publicada, tipo de
 *   vehículo); que la unidad esté libre se ve en cada fecha al generar.
 * - Generar crea los viajes de las fechas de la recurrencia dentro de la vigencia y del horizonte (hoy + 60 días), sin
 *   las excluidas ni las que ya tienen viaje de esta programación (UNIQUE en la base: idempotente). Cada viaje se crea
 *   con el mismo camino que un viaje puntual (TripsService.insertTrip).
 */
@Injectable()
export class SchedulesService {
  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly ctx: FleetContext,
    private readonly trips: TripsService,
  ) {}

  async list(): Promise<Schedule[]> {
    const rows = await this.db.transaction((tx) =>
      tx.schedule.findMany({
        orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { code: 'asc' }],
        include: SCHEDULE_INCLUDE,
      }),
    );
    return rows.map(toSchedule);
  }

  async get(id: string): Promise<Schedule> {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const row = await this.db.transaction((tx) =>
      tx.schedule.findFirst({ where: { id }, include: SCHEDULE_INCLUDE }),
    );
    if (!row) throw NOT_FOUND();
    return toSchedule(row);
  }

  async create(input: CreateScheduleRequest): Promise<Schedule> {
    if (input.validFrom < this.ctx.today()) throw invalid('La vigencia empieza hoy o más adelante');
    try {
      return await this.db.transaction(async (tx) => {
        const route = await this.trips.lockRoute(tx, input.routeId);
        if (route.archived) throw conflict('La ruta está archivada: restáurala antes de programarla');
        const unit = await this.defaultUnit(tx, route.modality, input);
        const row = await tx.schedule.create({
          data: {
            tenantId: this.ctx.tenantId(),
            code: input.code,
            routeId: input.routeId,
            timezone: this.tz(),
            ...fields(input, unit),
          },
          include: SCHEDULE_INCLUDE,
        });
        return toSchedule(row);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw conflict(`Ya existe una programación con el código ${input.code}`);
      }
      throw e;
    }
  }

  /** Cambia la recurrencia, la hora, la vigencia, las excluidas y la unidad; los viajes ya generados no cambian. */
  async update(id: string, input: UpdateScheduleRequest): Promise<Schedule> {
    return this.db.transaction(async (tx) => {
      const current = await this.lock(tx, id);
      if (current.archivedAt) throw conflict('La programación está archivada: restáurala antes de editarla');
      if (input.validFrom !== isoDate(current.validFrom) && input.validFrom < this.ctx.today()) {
        throw invalid('La vigencia empieza hoy o más adelante');
      }
      const route = await tx.route.findFirstOrThrow({
        where: { id: current.routeId },
        select: { modality: true },
      });
      const unit = await this.defaultUnit(tx, route.modality, input);
      const row = await tx.schedule.update({
        where: { id },
        data: fields(input, unit),
        include: SCHEDULE_INCLUDE,
      });
      return toSchedule(row);
    });
  }

  async archive(id: string, archived: boolean): Promise<Schedule> {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, id);
      const row = await tx.schedule.update({
        where: { id },
        data: { archivedAt: archived ? this.ctx.now() : null },
        include: SCHEDULE_INCLUDE,
      });
      return toSchedule(row);
    });
  }

  /** Genera los viajes que faltan hasta el horizonte. Idempotente. */
  async generate(id: string): Promise<GenerateScheduleResponse> {
    return this.db.transaction(async (tx) => {
      const s = await this.lock(tx, id);
      if (s.archivedAt) throw conflict('La programación está archivada');
      const route = await this.trips.lockRoute(tx, s.routeId);
      if (route.archived) throw conflict('La ruta está archivada');
      const today = this.ctx.today();
      const now = this.ctx.now();
      const from = isoDate(s.validFrom) > today ? isoDate(s.validFrom) : today;
      const horizon = addDays(today, SCHEDULE_HORIZON_DAYS);
      const validTo = s.validTo ? isoDate(s.validTo) : null;
      const until = validTo !== null && validTo < horizon ? validTo : horizon;
      const recurrence = fromRRule(s.recurrence);
      const excluded = new Set(s.excludedDates.map(isoDate));
      const done = new Set(
        (await tx.trip.findMany({ where: { scheduleId: id }, select: { departureDate: true } })).map((t) =>
          isoDate(t.departureDate as Date),
        ),
      );
      const last = route.stops[route.stops.length - 1];
      const result: GenerateScheduleResponse = {
        scheduleId: id,
        from,
        until,
        created: [],
        existing: 0,
        skipped: [],
        withoutUnit: [],
      };
      for (let date = from; date < until; date = addDays(date, 1)) {
        if (!occursOn(recurrence, date) || excluded.has(date)) continue;
        if (done.has(date)) {
          result.existing += 1;
          continue;
        }
        const departureLocal = `${date}T${s.departureLocalTime}`;
        const departure = localToInstant(departureLocal, s.timezone);
        if (departure <= now) {
          result.skipped.push({ date, reason: 'La hora de salida ya pasó' });
          continue;
        }
        const arrival = new Date(departure.getTime() + (last?.offsetMinutes ?? 0) * 60_000);
        const clash = await tx.trip.findFirst({
          where: { routeId: s.routeId, plannedDepartureAt: departure, status: { not: 'CANCELLED' } },
          select: { code: true },
        });
        if (clash) {
          result.skipped.push({ date, reason: `La ruta ya tiene el viaje ${clash.code} a esa hora` });
          continue;
        }
        let unit = { vehicleId: null as string | null, layoutVersionId: null as string | null };
        if (s.defaultVehicleId) {
          try {
            unit = await this.trips.resolveUnit(
              tx,
              route.modality,
              {
                vehicleId: s.defaultVehicleId,
                layout: s.version ? { layoutId: s.version.layoutId, version: s.version.version } : null,
              },
              departureLocal,
              departure,
              arrival,
              null,
            );
          } catch (e) {
            // La unidad no sirve en esta fecha (ocupada en otro viaje, retirada…): el viaje se crea sin unidad.
            if (!(e instanceof AppError)) throw e;
            result.withoutUnit.push({ date, reason: e.message });
          }
        }
        const tripId = await this.trips.insertTrip(tx, s.routeId, route, {
          departureLocal,
          departure,
          arrival,
          unit,
          minPassengers: null,
          confirmationDeadline: null,
          schedule: { id, date },
        });
        const trip = await tx.trip.findFirstOrThrow({
          where: { id: tripId },
          select: { code: true, vehicle: { select: { code: true } } },
        });
        result.created.push({ tripId, code: trip.code, date, vehicleCode: trip.vehicle?.code ?? null });
      }
      await tx.schedule.update({ where: { id }, data: { generatedUntil: day(until), lastGeneratedAt: now } });
      return result;
    });
  }

  /** Programaciones activas de la empresa del contexto (para el job del worker). */
  async activeIds(): Promise<string[]> {
    const rows = await this.db.transaction((tx) =>
      tx.schedule.findMany({
        where: { archivedAt: null, route: { archivedAt: null } },
        select: { id: true },
      }),
    );
    return rows.map((r) => r.id);
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** Unidad y plano por defecto, validados como en un viaje (sin mirar horarios: eso se ve en cada fecha). */
  private async defaultUnit(
    tx: Tx,
    modality: 'LAND' | 'RIVER',
    input: Pick<CreateScheduleRequest, 'vehicleId' | 'layout'>,
  ): Promise<{ vehicleId: string | null; layoutVersionId: string | null }> {
    if (!input.vehicleId) return { vehicleId: null, layoutVersionId: null };
    const vehicle = await tx.vehicle.findFirst({
      where: { id: input.vehicleId },
      select: { id: true, code: true, modality: true, status: true, vehicleTypeId: true },
    });
    if (!vehicle) throw invalid('La unidad no es de la empresa');
    if (vehicle.status === 'RETIRED') throw invalid(`La unidad ${vehicle.code} está retirada`);
    if (vehicle.modality !== modality)
      throw invalid(`La unidad ${vehicle.code} es de otra modalidad que la ruta`);
    if (!input.layout) return { vehicleId: vehicle.id, layoutVersionId: null };
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

  private async lock(tx: Tx, id: string) {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM schedules WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked) throw NOT_FOUND();
    return tx.schedule.findFirstOrThrow({
      where: { id },
      include: { version: { select: { layoutId: true, version: true } } },
    });
  }

  private tz(): string {
    return this.cls.get('tenant')?.timezone ?? DEFAULT_TIMEZONE;
  }
}

function fields(
  input: UpdateScheduleRequest,
  unit: { vehicleId: string | null; layoutVersionId: string | null },
) {
  return {
    recurrence: toRRule(input.recurrence),
    departureLocalTime: input.departureTime,
    validFrom: day(input.validFrom),
    validTo: input.validTo ? day(input.validTo) : null,
    excludedDates: [...input.excludedDates].sort().map(day),
    defaultVehicleId: unit.vehicleId,
    defaultLayoutVersionId: unit.layoutVersionId,
  };
}

function toSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    code: r.code,
    routeId: r.routeId,
    routeCode: r.route.code,
    routeName: r.route.name,
    recurrence: fromRRule(r.recurrence),
    rrule: r.recurrence,
    departureTime: r.departureLocalTime,
    timezone: r.timezone,
    validFrom: isoDate(r.validFrom),
    validTo: r.validTo ? isoDate(r.validTo) : null,
    excludedDates: r.excludedDates.map(isoDate),
    vehicle: r.vehicle,
    layout: r.version
      ? { layoutId: r.version.layoutId, name: r.version.layout.name, version: r.version.version }
      : null,
    archived: r.archivedAt !== null,
    generatedUntil: r.generatedUntil ? isoDate(r.generatedUntil) : null,
    lastGeneratedAt: r.lastGeneratedAt?.toISOString() ?? null,
  };
}
