import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  PATH_ENDPOINT_TOLERANCE_KM,
  distanceKm,
  pathLengthKm,
  roundKm,
  type CreateRouteRequest,
  type LngLat,
  type Modality,
  type Route,
  type RouteStop,
  type TraceImportResponse,
  type UpdateRouteRequest,
} from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { Clock } from '../identity/clock';
import { importTrace } from './trace-import';

const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, 400);
type Tx = Parameters<Parameters<TenantDbService['transaction']>[0]>[0];

const isUnique = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

const MODALITY_NAME: Record<Modality, string> = { LAND: 'terrestre', RIVER: 'fluvial' };
/** F7-Q7: en una ruta fluvial se avisa (sin impedir) de una parada que no es puerto ni embarcadero. */
const RIVER_KINDS = new Set(['PORT', 'LANDING']);

const WITH_STOPS = {
  stops: {
    orderBy: { seq: 'asc' },
    include: { location: { select: { name: true, kindCode: true, lat: true, lng: true } } },
  },
} as const satisfies Prisma.RouteInclude;

type StopInput = CreateRouteRequest['stops'][number];
type LocationRow = {
  id: string;
  name: string;
  kind_code: string;
  lat: number | null;
  lng: number | null;
  archived: boolean;
};

/**
 * Rutas y paradas de la empresa del host (Fase 7.1; data-dictionary §5; F7-Q7 y F7-Q9). Todo con `yebo_app` y el
 * tenant del contexto (RLS forzado): un id de otra empresa no existe (404), y una ubicación de otra empresa
 * tampoco (400).
 * - Las paradas se reemplazan enteras al editar (la base comprueba la ruta completa al confirmar). Los viajes las
 *   copian al crearse (7.3), así que editar una ruta no cambia los viajes ya creados.
 * - Las paradas van a ubicaciones activas de la empresa, bloqueadas en modo compartido mientras se guarda: archivar
 *   una ubicación espera, y luego ve que es parada de una ruta activa.
 * - Una traza va entre dos paradas ubicadas en el mapa y empieza y termina a PATH_ENDPOINT_TOLERANCE_KM de ellas.
 * - Nada se borra: se archiva. Restaurar exige que sus ubicaciones sigan activas.
 */
@Injectable()
export class RoutesService {
  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly clock: Clock,
  ) {}

  async routes(): Promise<Route[]> {
    const rows = await this.db.transaction((tx) =>
      tx.route.findMany({
        orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { code: 'asc' }],
        include: WITH_STOPS,
      }),
    );
    return rows.map(toRoute);
  }

  async route(id: string): Promise<Route> {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const row = await this.db.transaction((tx) => tx.route.findFirst({ where: { id }, include: WITH_STOPS }));
    if (!row) throw NOT_FOUND();
    return toRoute(row);
  }

  async create(input: CreateRouteRequest): Promise<Route> {
    const tenantId = this.tenantId();
    try {
      return await this.db.transaction(async (tx) => {
        await this.assertModality(tx, input.modality);
        await this.checkStops(tx, input.stops);
        const route = await tx.route.create({
          data: { tenantId, code: input.code, name: input.name, modality: input.modality },
        });
        await this.insertStops(tx, route.id, input.stops);
        return toRoute(await tx.route.findFirstOrThrow({ where: { id: route.id }, include: WITH_STOPS }));
      });
    } catch (e) {
      if (isUnique(e)) throw new AppError('CONFLICT', `Ya existe una ruta con el código ${input.code}`, 409);
      throw e;
    }
  }

  async update(id: string, input: UpdateRouteRequest): Promise<Route> {
    return this.db.transaction(async (tx) => {
      const current = await this.lock(tx, id);
      if (current.archived)
        throw new AppError('CONFLICT', 'La ruta está archivada: restáurala antes de editarla', 409);
      await this.checkStops(tx, input.stops);
      await tx.routeStop.deleteMany({ where: { routeId: id } });
      await this.insertStops(tx, id, input.stops);
      await tx.route.update({ where: { id }, data: { name: input.name } });
      return toRoute(await tx.route.findFirstOrThrow({ where: { id }, include: WITH_STOPS }));
    });
  }

  async archive(id: string, archived: boolean): Promise<Route> {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, id);
      if (!archived) {
        const stops = await tx.routeStop.findMany({ where: { routeId: id }, select: { locationId: true } });
        await this.activeLocations(
          tx,
          stops.map((s) => s.locationId),
        );
      }
      await tx.route.update({ where: { id }, data: { archivedAt: archived ? this.clock.now() : null } });
      return toRoute(await tx.route.findFirstOrThrow({ where: { id }, include: WITH_STOPS }));
    });
  }

  /** Lee un GPX o un KML y devuelve la traza para revisarla; no guarda nada (se guarda con la ruta). */
  importTrace(body: unknown): TraceImportResponse {
    return importTrace(body);
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** Ubicaciones activas de la empresa y trazas que empiezan y terminan en sus paradas. */
  private async checkStops(tx: Tx, stops: StopInput[]): Promise<void> {
    const locations = await this.activeLocations(
      tx,
      stops.map((s) => s.locationId),
    );
    stops.forEach((stop, i) => {
      const path = stop.pathToNext as LngLat[] | null;
      const next = stops[i + 1];
      if (!path || !next) return;
      const from = locations.get(stop.locationId) as LocationRow;
      const to = locations.get(next.locationId) as LocationRow;
      const leg = `Tramo ${from.name} → ${to.name}`;
      for (const l of [from, to]) {
        if (l.lat === null || l.lng === null) {
          throw invalid(`${leg}: ubica ${l.name} en el mapa antes de trazar el tramo`);
        }
      }
      const ends: [LngLat, LocationRow, string][] = [
        [path[0] as LngLat, from, 'empieza'],
        [path[path.length - 1] as LngLat, to, 'termina'],
      ];
      for (const [point, l, verb] of ends) {
        const km = distanceKm(point, [l.lng as number, l.lat as number]);
        if (km > PATH_ENDPOINT_TOLERANCE_KM) {
          throw invalid(
            `${leg}: la traza ${verb} a ${km.toFixed(1).replace('.', ',')} km de ${l.name} (máximo ${PATH_ENDPOINT_TOLERANCE_KM} km)`,
          );
        }
      }
    });
  }

  /** Bloquea las ubicaciones en modo compartido y exige que existan (en esta empresa) y estén activas. */
  private async activeLocations(tx: Tx, ids: string[]): Promise<Map<string, LocationRow>> {
    const unique = [...new Set(ids)];
    const rows = await tx.$queryRaw<LocationRow[]>`
      SELECT id::text, name, kind_code, lat::float8 AS lat, lng::float8 AS lng, archived_at IS NOT NULL AS archived
        FROM locations WHERE id = ANY(${unique}::uuid[]) ORDER BY id FOR SHARE`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of unique) {
      const row = byId.get(id);
      if (!row) throw invalid('Una de las paradas no es una ubicación de la empresa');
      if (row.archived) throw invalid(`La ubicación ${row.name} está archivada`);
    }
    return byId;
  }

  private async insertStops(tx: Tx, routeId: string, stops: StopInput[]): Promise<void> {
    const tenantId = this.tenantId();
    await tx.routeStop.createMany({
      data: stops.map((s, seq) => ({
        tenantId,
        routeId,
        seq,
        locationId: s.locationId,
        offsetMinutes: s.offsetMinutes,
        dwellMinutes: s.dwellMinutes,
        allowsBoarding: s.allowsBoarding,
        allowsAlighting: s.allowsAlighting,
        pathToNext: s.pathToNext === null ? Prisma.DbNull : (s.pathToNext as Prisma.InputJsonValue),
      })),
    });
  }

  /** La empresa opera la modalidad de la ruta (algún servicio activo en tenant_services). */
  private async assertModality(tx: Tx, modality: Modality): Promise<void> {
    const operated = await tx.tenantService.count({ where: { modality, enabled: true } });
    if (operated === 0) {
      throw invalid(`La empresa no opera servicios de transporte ${MODALITY_NAME[modality]}`);
    }
  }

  private async lock(tx: Tx, id: string): Promise<{ archived: boolean }> {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const [row] = await tx.$queryRaw<{ archived: boolean }[]>`
      SELECT archived_at IS NOT NULL AS archived FROM routes WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw NOT_FOUND();
    return row;
  }

  private tenantId(): string {
    const id = this.cls.get('tenantId');
    if (!id) throw new Error('RoutesService requiere el tenant del host');
    return id;
  }
}

type RouteRow = Prisma.RouteGetPayload<{ include: typeof WITH_STOPS }>;

const coord = (v: Prisma.Decimal | null): number | null => (v === null ? null : Number(v));

function toRoute(r: RouteRow): Route {
  const warnings: string[] = [];
  let fromOrigin: number | null = 0;
  const stops = r.stops.map((s, i): RouteStop => {
    const next = r.stops[i + 1];
    const lat = coord(s.location.lat);
    const lng = coord(s.location.lng);
    const path = (s.pathToNext as LngLat[] | null) ?? null;
    let kmToNext: number | null = null;
    if (next && path) kmToNext = roundKm(pathLengthKm(path));
    else if (
      next &&
      lat !== null &&
      lng !== null &&
      next.location.lat !== null &&
      next.location.lng !== null
    ) {
      kmToNext = roundKm(distanceKm([lng, lat], [Number(next.location.lng), Number(next.location.lat)]));
    }
    if (r.modality === 'RIVER' && !RIVER_KINDS.has(s.location.kindCode)) {
      warnings.push(`${s.location.name} no es puerto ni embarcadero`);
    }
    const stop: RouteStop = {
      seq: s.seq,
      locationId: s.locationId,
      locationName: s.location.name,
      locationKind: s.location.kindCode,
      lat,
      lng,
      offsetMinutes: s.offsetMinutes,
      dwellMinutes: s.dwellMinutes,
      allowsBoarding: s.allowsBoarding,
      allowsAlighting: s.allowsAlighting,
      pathToNext: path,
      kmToNext,
      kmFromOrigin: fromOrigin,
    };
    if (next) fromOrigin = fromOrigin === null || kmToNext === null ? null : roundKm(fromOrigin + kmToNext);
    return stop;
  });
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    modality: r.modality,
    archived: r.archivedAt !== null,
    stops,
    totalKm: stops[stops.length - 1]?.kmFromOrigin ?? null,
    warnings,
  };
}
