import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  LayoutDocumentSchema,
  farePhase,
  layoutPriceClasses,
  routePairs,
  type CreateFaresRequest,
  type CreateFaresResponse,
  type Fare,
  type FareMatrix,
  type FareMatrixQuery,
  type FareQuoteQuery,
  type FareService,
} from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { Clock } from '../identity/clock';

const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, 400);
const conflict = (message: string) => new AppError('CONFLICT', message, 409);
type Tx = Parameters<Parameters<TenantDbService['transaction']>[0]>[0];

/** Zona por defecto si el tenant resuelto aún no la trae (como en la flota). */
const DEFAULT_TIMEZONE = 'America/Lima';
const SERVICE_NAME: Record<FareService, string> = {
  PASSENGER: 'pasajeros',
  VEHICLE_TRANSPORT: 'transporte de vehículos',
};

const day = (d: string) => new Date(`${d}T00:00:00Z`);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
/** Fecha para los mensajes: 2026-12-01 → 01/12/2026. */
const human = (d: string) => d.split('-').reverse().join('/');

const FARE_INCLUDE = {
  origin: { select: { name: true } },
  destination: { select: { name: true } },
} as const satisfies Prisma.FareInclude;
type FareRow = Prisma.FareGetPayload<{ include: typeof FARE_INCLUDE }>;

type RouteStops = {
  id: string;
  modality: 'LAND' | 'RIVER';
  archived: boolean;
  stops: { locationId: string; name: string; allowsBoarding: boolean; allowsAlighting: boolean }[];
};
type Pairs = { list: { origin: string; destination: string }[]; keys: Set<string> };

/**
 * Tarifas de las rutas de la empresa del host (Fase 7.2; data-dictionary §5; F7-Q1; ADR-010). Todo con `yebo_app` y el
 * tenant del contexto (RLS forzado): una ruta o una tarifa de otra empresa no existe (404).
 * - Una tarifa no se edita: se crea otra con nueva vigencia, y la activa de la misma clave que empezó antes termina el
 *   día en que empieza la nueva (cambio de precio). La base impide solapamientos entre tarifas activas de una clave.
 * - Las fechas son del calendario de la empresa: nada empieza ni termina antes de hoy (el pasado no cambia).
 * - El par es de la ruta si se sube en el origen y se baja después en el destino. Al editar las paradas, las tarifas
 *   de pares que ya no existen se conservan marcadas `onRoute: false` y la consulta de precio no las usa.
 */
@Injectable()
export class FaresService {
  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly clock: Clock,
  ) {}

  /** Todas las tarifas de la ruta (historia incluida), en el orden de sus pares; las de fuera de la ruta al final. */
  async list(routeId: string): Promise<Fare[]> {
    const { route, rows } = await this.db.transaction(async (tx) => {
      const route = await this.loadRoute(tx, routeId);
      const rows = await tx.fare.findMany({
        where: { routeId },
        orderBy: [{ service: 'asc' }, { priceClassCode: 'asc' }, { validFrom: 'desc' }, { id: 'asc' }],
        include: FARE_INCLUDE,
      });
      return { route, rows };
    });
    const pairs = pairsOf(route);
    const rank = pairRank(pairs);
    const pos = (r: FareRow) =>
      rank.get(`${r.originLocationId}|${r.destinationLocationId}`) ?? pairs.list.length;
    const today = this.today();
    return rows
      .map((r, i) => ({ r, i }))
      .sort((x, y) => pos(x.r) - pos(y.r) || x.i - y.i)
      .map(({ r }) => toFare(r, today, pairs));
  }

  /** Pares × clases de la ruta en una fecha (hoy si falta): lo que tiene precio y lo que falta. */
  async matrix(routeId: string, query: FareMatrixQuery): Promise<FareMatrix> {
    const today = this.today();
    const date = query.date ?? today;
    const { route, rows, docs } = await this.db.transaction(async (tx) => {
      const route = await this.loadRoute(tx, routeId);
      const rows = await tx.fare.findMany({
        where: { routeId, service: query.service, ...validOn(date) },
        orderBy: [{ priceClassCode: 'asc' }],
        include: FARE_INCLUDE,
      });
      // Planos asignados hoy o más adelante a vehículos de la modalidad de la ruta que no están retirados.
      const assigned = await tx.vehicleLayoutAssignment.findMany({
        where: {
          OR: [{ validTo: null }, { validTo: { gt: day(today) } }],
          vehicle: { modality: route.modality, status: { not: 'RETIRED' } },
        },
        distinct: ['layoutVersionId'],
        select: { version: { select: { document: true } } },
      });
      return { route, rows, docs: assigned.map((a) => a.version.document) };
    });
    const pairs = pairsOf(route);
    const names = new Map(route.stops.map((s) => [s.locationId, s.name]));
    const fromLayouts = new Set(
      docs.flatMap((d) => layoutPriceClasses(LayoutDocumentSchema.parse(d), query.service)),
    );
    const rank = pairRank(pairs);
    // En el orden de los pares de la ruta y, en cada par, por clase.
    const onRoute = rows
      .filter((r) => rank.has(`${r.originLocationId}|${r.destinationLocationId}`))
      .sort(
        (x, y) =>
          (rank.get(`${x.originLocationId}|${x.destinationLocationId}`) ?? 0) -
            (rank.get(`${y.originLocationId}|${y.destinationLocationId}`) ?? 0) ||
          x.priceClassCode.localeCompare(y.priceClassCode),
      );
    const codes = [...new Set([...fromLayouts, ...onRoute.map((r) => r.priceClassCode)])].sort();
    const priced = new Set(
      onRoute.map((r) => `${r.originLocationId}|${r.destinationLocationId}|${r.priceClassCode}`),
    );
    return {
      routeId: route.id,
      service: query.service,
      date,
      pairs: pairs.list.map((p) => ({
        originLocationId: p.origin,
        originName: names.get(p.origin) ?? '',
        destinationLocationId: p.destination,
        destinationName: names.get(p.destination) ?? '',
      })),
      classes: codes.map((code) => ({ code, inLayouts: fromLayouts.has(code) })),
      fares: onRoute.map((r) => toFare(r, today, pairs)),
      missing: pairs.list.flatMap((p) =>
        codes
          .filter((c) => !priced.has(`${p.origin}|${p.destination}|${c}`))
          .map((c) => ({
            originLocationId: p.origin,
            destinationLocationId: p.destination,
            priceClassCode: c,
          })),
      ),
    };
  }

  /** «Precio de A a B en la clase X en la fecha F» (hoy si falta). 404 si no hay tarifa vigente. */
  async quote(routeId: string, q: FareQuoteQuery): Promise<Fare> {
    const today = this.today();
    const date = q.date ?? today;
    const { route, row } = await this.db.transaction(async (tx) => {
      const route = await this.loadRoute(tx, routeId);
      const row = await tx.fare.findFirst({
        where: {
          routeId,
          originLocationId: q.origin,
          destinationLocationId: q.destination,
          service: q.service,
          priceClassCode: q.priceClass,
          ...validOn(date),
        },
        include: FARE_INCLUDE,
      });
      return { route, row };
    });
    const pairs = pairsOf(route);
    if (!pairs.keys.has(`${q.origin}|${q.destination}`)) {
      throw invalid('En esta ruta no se viaja de ese origen a ese destino');
    }
    if (!row) {
      throw new AppError(
        'NOT_FOUND',
        `No hay tarifa ${q.priceClass} de ${SERVICE_NAME[q.service]} para ese tramo el ${human(date)}`,
        404,
      );
    }
    return toFare(row, today, pairs);
  }

  /**
   * Crea las tarifas (todas o ninguna). La tarifa activa de la misma clave que empezó antes y sigue vigente el día
   * `validFrom` termina ese día; cualquier otro solapamiento (una tarifa que empieza ese día o después) es un 409.
   */
  async create(routeId: string, input: CreateFaresRequest): Promise<CreateFaresResponse> {
    const tenantId = this.tenantId();
    const today = this.today();
    if (input.validFrom < today) throw invalid('La vigencia empieza hoy o más adelante: el pasado no cambia');
    try {
      return await this.db.transaction(async (tx) => {
        const route = await this.loadRoute(tx, routeId, true);
        if (route.archived) throw conflict('La ruta está archivada: restáurala antes de ponerle tarifas');
        const operated = await tx.tenantService.count({
          where: { modality: route.modality, service: input.service, enabled: true },
        });
        if (operated === 0) {
          throw invalid(`La empresa no opera ${SERVICE_NAME[input.service]} en esta modalidad`);
        }
        const pairs = pairsOf(route);
        const names = new Map(route.stops.map((s) => [s.locationId, s.name]));
        input.items.forEach((item) => {
          if (!pairs.keys.has(`${item.originLocationId}|${item.destinationLocationId}`)) {
            const from = names.get(item.originLocationId);
            const to = names.get(item.destinationLocationId);
            throw invalid(
              from && to
                ? `En esta ruta no se viaja de ${from} a ${to}`
                : 'Una de las tarifas es de una ubicación que no es parada de la ruta',
            );
          }
        });
        const keys = {
          origins: input.items.map((i) => i.originLocationId),
          destinations: input.items.map((i) => i.destinationLocationId),
          classes: input.items.map((i) => i.priceClassCode),
        };
        // Cambio de precio: termina la tarifa activa de cada clave que empezó antes y sigue vigente ese día.
        const ended = await tx.$queryRaw<{ id: string }[]>`
          UPDATE fares f SET valid_to = ${day(input.validFrom)}::date, updated_at = now()
            FROM unnest(${keys.origins}::uuid[], ${keys.destinations}::uuid[], ${keys.classes}::text[]) AS k(o, d, c)
           WHERE f.route_id = ${routeId}::uuid AND f.service = ${input.service}::transport_service
             AND f.status = 'ACTIVE' AND f.origin_location_id = k.o AND f.destination_location_id = k.d
             AND f.price_class_code = k.c AND f.valid_from < ${day(input.validFrom)}::date
             AND (f.valid_to IS NULL OR f.valid_to > ${day(input.validFrom)}::date)
          RETURNING f.id::text AS id`;
        // Lo que queda solapado empieza ese día o después: se avisa con la tarifa concreta (la base es la garantía).
        const [clash] = await tx.$queryRaw<
          { origin: string; destination: string; price_class_code: string; valid_from: Date }[]
        >`
          SELECT o.name AS origin, d.name AS destination, f.price_class_code, f.valid_from
            FROM fares f
            JOIN unnest(${keys.origins}::uuid[], ${keys.destinations}::uuid[], ${keys.classes}::text[]) AS k(o, d, c)
              ON f.origin_location_id = k.o AND f.destination_location_id = k.d AND f.price_class_code = k.c
            JOIN locations o ON o.id = f.origin_location_id
            JOIN locations d ON d.id = f.destination_location_id
           WHERE f.route_id = ${routeId}::uuid AND f.service = ${input.service}::transport_service
             AND f.status = 'ACTIVE'
             AND daterange(f.valid_from, f.valid_to, '[)')
                 && daterange(${day(input.validFrom)}::date, ${input.validTo ? day(input.validTo) : null}::date, '[)')
           ORDER BY f.valid_from LIMIT 1`;
        if (clash) {
          throw conflict(
            `Ya hay una tarifa ${clash.price_class_code} de ${clash.origin} a ${clash.destination} desde el ` +
              `${human(isoDate(clash.valid_from))}: anúlala o cambia la vigencia de la nueva`,
          );
        }
        await tx.fare.createMany({
          data: input.items.map((item) => ({
            tenantId,
            routeId,
            originLocationId: item.originLocationId,
            destinationLocationId: item.destinationLocationId,
            service: input.service,
            priceClassCode: item.priceClassCode,
            amount: item.amount,
            validFrom: day(input.validFrom),
            validTo: input.validTo ? day(input.validTo) : null,
          })),
        });
        const created = await tx.fare.findMany({
          where: {
            routeId,
            service: input.service,
            status: 'ACTIVE',
            validFrom: day(input.validFrom),
            OR: input.items.map((i) => ({
              originLocationId: i.originLocationId,
              destinationLocationId: i.destinationLocationId,
              priceClassCode: i.priceClassCode,
            })),
          },
          include: FARE_INCLUDE,
        });
        const closed = await tx.fare.findMany({
          where: { id: { in: ended.map((e) => e.id) } },
          include: FARE_INCLUDE,
        });
        const order = new Map(input.items.map((i, n) => [fareKey(i), n]));
        created.sort((x, y) => (order.get(fareKey(x)) ?? 0) - (order.get(fareKey(y)) ?? 0));
        return {
          fares: created.map((r) => toFare(r, today, pairs)),
          ended: closed.map((r) => toFare(r, today, pairs)),
        };
      });
    } catch (e) {
      throw overlap(e) ?? e;
    }
  }

  /** Termina una tarifa (o mueve su fin): no antes de hoy ni de su inicio; una que ya terminó no se reabre. */
  async end(id: string, validTo: string): Promise<Fare> {
    const today = this.today();
    try {
      return await this.db.transaction(async (tx) => {
        const fare = await this.lockFare(tx, id);
        if (fare.status === 'CANCELLED') throw conflict('La tarifa está anulada');
        if (fare.validTo !== null && fare.validTo <= today) throw conflict('La tarifa ya terminó');
        if (validTo < today) throw invalid('El fin es hoy o más adelante: el pasado no cambia');
        if (validTo <= fare.validFrom) throw invalid('El fin es posterior al inicio');
        const row = await tx.fare.update({
          where: { id },
          data: { validTo: day(validTo) },
          include: FARE_INCLUDE,
        });
        return toFare(row, today, pairsOf(await this.loadRoute(tx, row.routeId)));
      });
    } catch (e) {
      throw overlap(e) ?? e;
    }
  }

  /** Anula una tarifa que aún no empieza (una que ya empezó se termina con `end`). */
  async cancel(id: string): Promise<Fare> {
    const today = this.today();
    return this.db.transaction(async (tx) => {
      const fare = await this.lockFare(tx, id);
      if (fare.status === 'CANCELLED') throw conflict('La tarifa ya está anulada');
      if (fare.validFrom <= today) {
        throw conflict('La tarifa ya empezó: ponle fin en vez de anularla');
      }
      const row = await tx.fare.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: this.clock.now() },
        include: FARE_INCLUDE,
      });
      return toFare(row, today, pairsOf(await this.loadRoute(tx, row.routeId)));
    });
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** La ruta con sus paradas en orden. `share`: bloqueada contra la edición de sus paradas mientras se guarda. */
  private async loadRoute(tx: Tx, id: string, share = false): Promise<RouteStops> {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    if (share) {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text FROM routes WHERE id = ${id}::uuid FOR SHARE`;
      if (!locked) throw NOT_FOUND();
    }
    const route = await tx.route.findFirst({
      where: { id },
      select: {
        id: true,
        modality: true,
        archivedAt: true,
        stops: {
          orderBy: { seq: 'asc' },
          select: {
            locationId: true,
            allowsBoarding: true,
            allowsAlighting: true,
            location: { select: { name: true } },
          },
        },
      },
    });
    if (!route) throw NOT_FOUND();
    return {
      id: route.id,
      modality: route.modality,
      archived: route.archivedAt !== null,
      stops: route.stops.map((s) => ({
        locationId: s.locationId,
        name: s.location.name,
        allowsBoarding: s.allowsBoarding,
        allowsAlighting: s.allowsAlighting,
      })),
    };
  }

  private async lockFare(
    tx: Tx,
    id: string,
  ): Promise<{ status: 'ACTIVE' | 'CANCELLED'; validFrom: string; validTo: string | null }> {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const [row] = await tx.$queryRaw<
      { status: 'ACTIVE' | 'CANCELLED'; valid_from: Date; valid_to: Date | null }[]
    >`
      SELECT status::text AS status, valid_from, valid_to FROM fares WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw NOT_FOUND();
    return {
      status: row.status,
      validFrom: isoDate(row.valid_from),
      validTo: row.valid_to ? isoDate(row.valid_to) : null,
    };
  }

  /** Fecha `AAAA-MM-DD` de hoy en la zona horaria de la empresa. */
  private today(): string {
    const timeZone = this.cls.get('tenant')?.timezone ?? DEFAULT_TIMEZONE;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(this.clock.now());
  }

  private tenantId(): string {
    const id = this.cls.get('tenantId');
    if (!id) throw new Error('FaresService requiere el tenant del host');
    return id;
  }
}

/** Tarifas activas vigentes en la fecha: `valid_from ≤ fecha < valid_to`. */
function validOn(date: string) {
  return {
    status: 'ACTIVE' as const,
    validFrom: { lte: day(date) },
    OR: [{ validTo: null }, { validTo: { gt: day(date) } }],
  };
}

function pairsOf(route: RouteStops): Pairs {
  const list = routePairs(route.stops);
  return { list, keys: new Set(list.map((p) => `${p.origin}|${p.destination}`)) };
}

const pairRank = (pairs: Pairs) => new Map(pairs.list.map((p, i) => [`${p.origin}|${p.destination}`, i]));

const fareKey = (f: { originLocationId: string; destinationLocationId: string; priceClassCode: string }) =>
  `${f.originLocationId}|${f.destinationLocationId}|${f.priceClassCode}`;

function toFare(r: FareRow, today: string, pairs: Pairs): Fare {
  const validFrom = isoDate(r.validFrom);
  const validTo = r.validTo ? isoDate(r.validTo) : null;
  return {
    id: r.id,
    routeId: r.routeId,
    originLocationId: r.originLocationId,
    originName: r.origin.name,
    destinationLocationId: r.destinationLocationId,
    destinationName: r.destination.name,
    service: r.service as FareService,
    priceClassCode: r.priceClassCode,
    currency: 'PEN',
    amount: r.amount.toFixed(2),
    validFrom,
    validTo,
    status: r.status,
    phase: farePhase({ status: r.status, validFrom, validTo }, today),
    onRoute: pairs.keys.has(`${r.originLocationId}|${r.destinationLocationId}`),
  };
}

/** Solapamiento entre tarifas activas de la misma clave (EXCLUDE fares_no_overlap): 409. */
function overlap(e: unknown): AppError | null {
  const text =
    e instanceof Error ? `${e.message} ${JSON.stringify((e as { meta?: unknown }).meta ?? {})}` : '';
  if (!/23P01|fares_no_overlap/i.test(text)) return null;
  return conflict('Ya hay una tarifa activa para ese tramo y esa clase en esas fechas');
}
