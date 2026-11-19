import { z } from 'zod';
import { ModalitySchema } from './fleet';

/**
 * Fase 7.1 · Rutas y paradas (data-dictionary §5; F7-Q7 y F7-Q9).
 * - Una ruta es una lista ordenada de paradas sobre las ubicaciones de la empresa (6.1). Cada parada guarda los
 *   minutos desde la salida del origen (viajes de varios días en río), el tiempo de parada y si se puede subir o
 *   bajar. Los viajes copian las paradas al crearse (Fase 7.3): editar la ruta no cambia los viajes ya creados.
 * - Traza (F7-Q9): cada tramo puede llevar la línea hacia la parada siguiente, como coordenadas GeoJSON
 *   `[lng, lat]`. Sin traza, el mapa dibuja una línea recta.
 */

// ---------------------------------------------------------------------------------------------------------------
// Geometría de las trazas (pura, compartida por la API y el editor de rutas)
// ---------------------------------------------------------------------------------------------------------------

/** Punto GeoJSON: `[longitud, latitud]`. */
export type LngLat = [number, number];

/** Rectángulo que contiene el Perú, con un margen pequeño (fronteras y ríos limítrofes). */
export const PERU_BOUNDS = { minLat: -18.6, maxLat: 0.2, minLng: -81.6, maxLng: -68.4 } as const;
/** Puntos de una traza guardada. Una importación más densa se simplifica hasta este máximo. */
export const PATH_MAX_POINTS = 2000;
/** Distancia máxima entre un extremo de la traza y su parada. */
export const PATH_ENDPOINT_TOLERANCE_KM = 5;
/** Tamaño máximo de un archivo GPX o KML a importar. */
export const TRACE_FILE_MAX_BYTES = 5 * 1024 * 1024;

export const inPeru = ([lng, lat]: LngLat): boolean =>
  lat >= PERU_BOUNDS.minLat &&
  lat <= PERU_BOUNDS.maxLat &&
  lng >= PERU_BOUNDS.minLng &&
  lng <= PERU_BOUNDS.maxLng;

const EARTH_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

/** Distancia sobre la superficie terrestre (haversine), en km. */
export function distanceKm([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Largo de una traza, en km. */
export function pathLengthKm(points: readonly LngLat[]): number {
  let km = 0;
  for (let i = 1; i < points.length; i++) km += distanceKm(points[i - 1] as LngLat, points[i] as LngLat);
  return km;
}

/** Km con dos decimales (lo que se guarda y se muestra). */
export const roundKm = (km: number): number => Math.round(km * 100) / 100;

/** Coordenada con 6 decimales (~10 cm), como `locations.lat/lng`. */
export const roundCoord = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Área (en grados², plana) del triángulo a-b-c: lo que aporta `b` a la forma entre sus vecinos. */
const triangleArea = (a: LngLat, b: LngLat, c: LngLat): number =>
  Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

/** Montículo mínimo de pares (área, índice), con entradas obsoletas que se descartan al sacarlas. */
class MinHeap {
  private readonly areas: number[] = [];
  private readonly ids: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(area: number, id: number): void {
    this.areas.push(area);
    this.ids.push(id);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((this.areas[parent] as number) <= area) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.areas[0] as number, this.ids[0] as number];
    const area = this.areas.pop() as number;
    const id = this.ids.pop() as number;
    if (this.ids.length > 0) {
      this.areas[0] = area;
      this.ids[0] = id;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && (this.areas[l] as number) < (this.areas[m] as number)) m = l;
        if (r < this.ids.length && (this.areas[r] as number) < (this.areas[m] as number)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(i: number, j: number): void {
    [this.areas[i], this.areas[j]] = [this.areas[j] as number, this.areas[i] as number];
    [this.ids[i], this.ids[j]] = [this.ids[j] as number, this.ids[i] as number];
  }
}

/** Separación mínima entre puntos seguidos (~5 m): quita el ruido del GPS con el vehículo detenido. */
const MIN_STEP_DEG = 0.00005;

/**
 * Reduce una traza a `maxPoints` como mucho, conservando su forma: Visvalingam–Whyatt (quita una y otra vez el
 * punto que menos área aporta con sus vecinos), con un montículo: O(n log n) en cualquier traza, también en una de
 * GPS ruidosa de cientos de miles de puntos. Antes quita los puntos a menos de ~5 m del anterior (repetidos y ruido
 * en las paradas). Los extremos siempre se conservan.
 */
export function simplifyPath(points: readonly LngLat[], maxPoints = PATH_MAX_POINTS): LngLat[] {
  const last = points[points.length - 1];
  const p: LngLat[] = [];
  for (const point of points) {
    const prev = p[p.length - 1];
    if (!prev || Math.hypot(point[0] - prev[0], point[1] - prev[1]) >= MIN_STEP_DEG) p.push(point);
  }
  if (last && p.length > 1) p[p.length - 1] = last;
  const target = Math.max(2, maxPoints);
  if (p.length <= target) return p;

  const n = p.length;
  const prev = Int32Array.from({ length: n }, (_, i) => i - 1);
  const next = Int32Array.from({ length: n }, (_, i) => i + 1);
  const area = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap();
  for (let i = 1; i < n - 1; i++) {
    area[i] = triangleArea(p[i - 1] as LngLat, p[i] as LngLat, p[i + 1] as LngLat);
    heap.push(area[i] as number, i);
  }
  let remaining = n;
  let floor = 0;
  while (remaining > target && heap.size > 0) {
    const [a, i] = heap.pop();
    if (a !== area[i]) continue; // entrada obsoleta (el punto ya salió o cambió su área)
    floor = Math.max(floor, a);
    area[i] = NaN; // fuera
    const before = prev[i] as number;
    const after = next[i] as number;
    next[before] = after;
    prev[after] = before;
    remaining--;
    for (const j of [before, after]) {
      if (j <= 0 || j >= n - 1) continue;
      // Un vecino nunca vale menos que el punto que acaba de salir (área monótona).
      area[j] = Math.max(
        floor,
        triangleArea(p[prev[j] as number] as LngLat, p[j] as LngLat, p[next[j] as number] as LngLat),
      );
      heap.push(area[j] as number, j);
    }
  }
  const result: LngLat[] = [];
  for (let i = 0; i !== n; i = next[i] as number) result.push(p[i] as LngLat);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Esquemas
// ---------------------------------------------------------------------------------------------------------------

const Text = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Paradas de una ruta: al menos el origen y el destino. */
export const ROUTE_MAX_STOPS = 50;
/** Minutos desde el origen: hasta 30 días (los viajes fluviales largos duran 4 o 5). */
export const ROUTE_MAX_OFFSET_MINUTES = 30 * 24 * 60;
/** Tiempo de parada: hasta 2 días (una escala larga para cargar). */
export const ROUTE_MAX_DWELL_MINUTES = 2 * 24 * 60;

/** Código de ruta: mayúsculas, números y guion; no cambia después de crearla. */
export const RouteCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,15}$/, 'Usa de 2 a 16 letras, números o guiones');

export const LngLatSchema = z
  .tuple([z.number().finite(), z.number().finite()])
  .transform(([lng, lat]): LngLat => [roundCoord(lng), roundCoord(lat)])
  .refine(inPeru, { message: 'La traza tiene puntos fuera del Perú' });

export const RoutePathSchema = z
  .array(LngLatSchema)
  .min(2, 'Una traza tiene al menos 2 puntos')
  .max(PATH_MAX_POINTS, `Una traza tiene como mucho ${PATH_MAX_POINTS} puntos`);

export const RouteStopInputSchema = z
  .object({
    locationId: z.uuid(),
    /** Minutos desde la salida del origen hasta la llegada a esta parada (0 en el origen). */
    offsetMinutes: z.number().int().min(0).max(ROUTE_MAX_OFFSET_MINUTES),
    /** Minutos que el vehículo se queda en la parada. */
    dwellMinutes: z.number().int().min(0).max(ROUTE_MAX_DWELL_MINUTES),
    allowsBoarding: z.boolean(),
    allowsAlighting: z.boolean(),
    /** Traza hasta la parada siguiente (null: línea recta). La última parada no tiene. */
    pathToNext: RoutePathSchema.nullable(),
  })
  .strict();
export type RouteStopInput = z.input<typeof RouteStopInputSchema>;

const stopsRules = (stops: z.infer<typeof RouteStopInputSchema>[], ctx: z.RefinementCtx) => {
  const issue = (message: string, index: number, field: string) =>
    ctx.addIssue({ code: 'custom', message, path: ['stops', index, field] });
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return;
  if (first.offsetMinutes !== 0) issue('El origen tiene 0 minutos', 0, 'offsetMinutes');
  if (!first.allowsBoarding) issue('En el origen se sube', 0, 'allowsBoarding');
  if (!last.allowsAlighting) issue('En el destino se baja', stops.length - 1, 'allowsAlighting');
  if (last.pathToNext !== null) issue('El destino no tiene tramo siguiente', stops.length - 1, 'pathToNext');
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1] as (typeof stops)[number];
    const stop = stops[i] as (typeof stops)[number];
    if (stop.locationId === prev.locationId) {
      issue('Dos paradas seguidas no pueden ser la misma ubicación', i, 'locationId');
    }
    if (stop.offsetMinutes <= prev.offsetMinutes + prev.dwellMinutes) {
      issue('Llega después de salir de la parada anterior', i, 'offsetMinutes');
    }
  }
  stops.forEach((s, i) => {
    if (i > 0 && i < stops.length - 1 && !s.allowsBoarding && !s.allowsAlighting) {
      issue('Una parada intermedia permite subir, bajar o ambas', i, 'allowsBoarding');
    }
  });
};

const Stops = z
  .array(RouteStopInputSchema)
  .min(2, 'Una ruta tiene al menos origen y destino')
  .max(ROUTE_MAX_STOPS);

export const CreateRouteRequestSchema = z
  .object({ code: RouteCodeSchema, name: Text(2, 80), modality: ModalitySchema, stops: Stops })
  .strict()
  .superRefine((r, ctx) => stopsRules(r.stops, ctx));
export type CreateRouteRequest = z.infer<typeof CreateRouteRequestSchema>;

/** El código y la modalidad no cambian; el nombre y las paradas sí (los viajes ya creados no se enteran). */
export const UpdateRouteRequestSchema = z
  .object({ name: Text(2, 80), stops: Stops })
  .strict()
  .superRefine((r, ctx) => stopsRules(r.stops, ctx));
export type UpdateRouteRequest = z.infer<typeof UpdateRouteRequestSchema>;

export const RouteStopSchema = z.object({
  seq: z.number().int(),
  locationId: z.string(),
  locationName: z.string(),
  locationKind: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  offsetMinutes: z.number().int(),
  dwellMinutes: z.number().int(),
  allowsBoarding: z.boolean(),
  allowsAlighting: z.boolean(),
  pathToNext: z.array(z.tuple([z.number(), z.number()])).nullable(),
  /**
   * Km hasta la parada siguiente: el largo de la traza o, sin ella, la línea recta entre las dos paradas (null si
   * alguna no está ubicada en el mapa). Null en el destino.
   */
  kmToNext: z.number().nullable(),
  /** Km desde el origen (null si algún tramo anterior no se puede medir). */
  kmFromOrigin: z.number().nullable(),
});
export type RouteStop = z.infer<typeof RouteStopSchema>;

export const RouteSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  modality: ModalitySchema,
  archived: z.boolean(),
  stops: z.array(RouteStopSchema),
  /** Km del origen al destino (null si algún tramo no se puede medir). */
  totalKm: z.number().nullable(),
  /** Avisos que no impiden guardar (F7-Q7: en una ruta fluvial, una parada que no es puerto ni embarcadero). */
  warnings: z.array(z.string()),
});
export type Route = z.infer<typeof RouteSchema>;

export const RoutesResponseSchema = z.object({ routes: z.array(RouteSchema) });
export type RoutesResponse = z.infer<typeof RoutesResponseSchema>;

/** Resultado de importar un GPX o un KML: la traza (ya simplificada) para revisarla y guardarla con la ruta. */
export const TraceImportResponseSchema = z.object({
  format: z.enum(['GPX', 'KML']),
  points: z.array(z.tuple([z.number(), z.number()])),
  /** Puntos que traía el archivo, antes de simplificar. */
  sourcePoints: z.number().int(),
  km: z.number(),
});
export type TraceImportResponse = z.infer<typeof TraceImportResponseSchema>;
