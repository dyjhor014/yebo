import { z } from 'zod';
import { ZONE_RULES, deriveInventory, type LayoutDocument } from './layouts';

/**
 * Fase 7.2 · Tarifas (data-dictionary §5; F7-Q1; ADR-010).
 * - Una tarifa es el precio de un par origen → destino de una ruta, para un servicio y una clase de precio (GENERAL,
 *   VIP, CAMA, CAMAROTE, HAMACA, CABINA, TOLVA, VEHICULO…), en soles, con vigencia por fechas `[desde, hasta)`: el día
 *   `validTo` ya no vale (como las asignaciones de planos de la 6.3). Sin `validTo`, vale sin fin.
 * - Una tarifa no se edita: su monto no cambia. Para cambiar un precio se crea otra con nueva vigencia; la anterior
 *   termina el día que empieza la nueva. Una tarifa que aún no empieza se puede anular.
 * - El par es de ubicaciones (no de paradas): sigue valiendo si se editan las paradas, mientras la ruta permita subir
 *   en el origen y bajar en el destino, en ese orden.
 * - Sin descuentos, promociones ni precio por canal (F7-Q1): llegan con la venta (Fase 8).
 */

/** Servicios con tarifa por unidad en esta fase. Encomiendas y carga tienen su propio tarifario
 * (fases 9 y 10): por peso, por volumen o por ambos, según lo que decida cada empresa. */
export const FARE_SERVICES = ['PASSENGER', 'VEHICLE_TRANSPORT'] as const;
export const FareServiceSchema = z.enum(FARE_SERVICES);
export type FareService = z.infer<typeof FareServiceSchema>;

export const FARE_CURRENCY = 'PEN';
/** Monto máximo de una tarifa (S/ 99 999,99), como el CHECK de la base. */
export const FARE_MAX_AMOUNT = '99999.99';
/** Tarifas por envío: la matriz completa de una ruta grande (50 paradas ≈ 1225 pares) en varias clases, por partes. */
export const FARES_PER_REQUEST = 500;

export const PriceClassCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{1,23}$/, 'Clase de precio en mayúsculas (p. ej., GENERAL, VIP, CAMA)');

/** Monto en soles con hasta 2 decimales, mayor que 0 y hasta FARE_MAX_AMOUNT. Se normaliza a `0.00`. */
export const FareAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,5}(\.\d{1,2})?$/, 'Monto en soles con hasta 2 decimales (p. ej., 45.50)')
  .transform((v) => Number(v).toFixed(2))
  .refine((v) => Number(v) > 0, 'El monto es mayor que 0');

const IsoDate = z.iso.date();

export const FareItemInputSchema = z
  .object({
    originLocationId: z.uuid(),
    destinationLocationId: z.uuid(),
    priceClassCode: PriceClassCodeSchema,
    amount: FareAmountSchema,
  })
  .strict();
export type FareItemInput = z.input<typeof FareItemInputSchema>;

/**
 * Crea tarifas de una ruta para un servicio y una vigencia, todas o ninguna. Si una tarifa activa de la misma clave
 * (par, servicio y clase) empezó antes y sigue vigente el día `validFrom`, termina ese día: es el cambio de precio.
 */
export const CreateFaresRequestSchema = z
  .object({
    service: FareServiceSchema,
    /** Desde hoy (en la zona horaria de la empresa) en adelante: el pasado no cambia. */
    validFrom: IsoDate,
    validTo: IsoDate.nullable(),
    items: z.array(FareItemInputSchema).min(1).max(FARES_PER_REQUEST),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.validTo !== null && r.validTo <= r.validFrom) {
      ctx.addIssue({ code: 'custom', message: 'El fin es posterior al inicio', path: ['validTo'] });
    }
    const seen = new Set<string>();
    r.items.forEach((item, i) => {
      if (item.originLocationId === item.destinationLocationId) {
        ctx.addIssue({
          code: 'custom',
          message: 'El origen y el destino son distintos',
          path: ['items', i, 'destinationLocationId'],
        });
      }
      const key = `${item.originLocationId}|${item.destinationLocationId}|${item.priceClassCode}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Ese par y esa clase ya están en la lista',
          path: ['items', i, 'priceClassCode'],
        });
      }
      seen.add(key);
    });
  });
export type CreateFaresRequest = z.infer<typeof CreateFaresRequestSchema>;

/** Termina una tarifa (o mueve su fin). El fin es posterior al inicio y no anterior a hoy. */
export const EndFareRequestSchema = z.object({ validTo: IsoDate }).strict();
export type EndFareRequest = z.infer<typeof EndFareRequestSchema>;

export const FareStatusSchema = z.enum(['ACTIVE', 'CANCELLED']);
export type FareStatus = z.infer<typeof FareStatusSchema>;

/** Estado de una tarifa respecto de hoy: anulada, por empezar, vigente o terminada. */
export const FarePhaseSchema = z.enum(['CANCELLED', 'SCHEDULED', 'CURRENT', 'ENDED']);
export type FarePhase = z.infer<typeof FarePhaseSchema>;

export const FareSchema = z.object({
  id: z.string(),
  routeId: z.string(),
  originLocationId: z.string(),
  originName: z.string(),
  destinationLocationId: z.string(),
  destinationName: z.string(),
  service: FareServiceSchema,
  priceClassCode: z.string(),
  currency: z.literal(FARE_CURRENCY),
  /** Monto con 2 decimales, como texto (sin errores de coma flotante). */
  amount: z.string(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  status: FareStatusSchema,
  phase: FarePhaseSchema,
  /** El par sigue siendo de la ruta (se sube en el origen y se baja en el destino, en ese orden). */
  onRoute: z.boolean(),
});
export type Fare = z.infer<typeof FareSchema>;

export const FaresResponseSchema = z.object({ fares: z.array(FareSchema) });
export type FaresResponse = z.infer<typeof FaresResponseSchema>;

export const CreateFaresResponseSchema = z.object({
  fares: z.array(FareSchema),
  /** Tarifas que terminaron el día en que empiezan las nuevas (cambio de precio). */
  ended: z.array(FareSchema),
});
export type CreateFaresResponse = z.infer<typeof CreateFaresResponseSchema>;

export const FarePairSchema = z.object({
  originLocationId: z.string(),
  originName: z.string(),
  destinationLocationId: z.string(),
  destinationName: z.string(),
});
export type FarePair = z.infer<typeof FarePairSchema>;

/** Matriz de tarifas de una ruta en una fecha: pares × clases, con lo que tiene precio y lo que falta. */
export const FareMatrixSchema = z.object({
  routeId: z.string(),
  service: FareServiceSchema,
  date: z.string(),
  pairs: z.array(FarePairSchema),
  /**
   * Clases de la matriz: las de los planos publicados y asignados (hoy o más adelante) a vehículos activos de la
   * modalidad de la ruta, y las que ya tienen tarifa en la ruta.
   */
  classes: z.array(z.object({ code: z.string(), inLayouts: z.boolean() })),
  fares: z.array(FareSchema),
  /** Pares y clases sin tarifa vigente en la fecha. */
  missing: z.array(
    z.object({ originLocationId: z.string(), destinationLocationId: z.string(), priceClassCode: z.string() }),
  ),
});
export type FareMatrix = z.infer<typeof FareMatrixSchema>;

export const FareMatrixQuerySchema = z
  .object({ service: FareServiceSchema.default('PASSENGER'), date: IsoDate.optional() })
  .strict();
export type FareMatrixQuery = z.infer<typeof FareMatrixQuerySchema>;

/** «Precio de A a B en la clase X en la fecha F». Sin fecha, hoy. */
export const FareQuoteQuerySchema = z
  .object({
    origin: z.uuid(),
    destination: z.uuid(),
    priceClass: PriceClassCodeSchema,
    service: FareServiceSchema.default('PASSENGER'),
    date: IsoDate.optional(),
  })
  .strict();
export type FareQuoteQuery = z.infer<typeof FareQuoteQuerySchema>;

// ---------------------------------------------------------------------------------------------------------------
// Reglas puras (compartidas por la API y la pantalla de tarifas)
// ---------------------------------------------------------------------------------------------------------------

type PairStop = { locationId: string; allowsBoarding: boolean; allowsAlighting: boolean };

/**
 * Pares origen → destino de una ruta: se sube en una parada y se baja en otra posterior, de otra ubicación. En una ida
 * y vuelta (A → B → A) el par A → A no existe y cada par aparece una vez, en el orden de su primera aparición.
 */
export function routePairs(stops: readonly PairStop[]): { origin: string; destination: string }[] {
  const pairs: { origin: string; destination: string }[] = [];
  const seen = new Set<string>();
  stops.forEach((from, i) => {
    if (!from.allowsBoarding) return;
    for (const to of stops.slice(i + 1)) {
      if (!to.allowsAlighting || to.locationId === from.locationId) continue;
      const key = `${from.locationId}|${to.locationId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ origin: from.locationId, destination: to.locationId });
    }
  });
  return pairs;
}

/**
 * Clases de precio que vende un plano para un servicio: las de sus recursos vendibles (asientos, camas, camarotes y
 * espacios de vehículo, también el camarote que se vende completo) y, en pasajeros, las de sus zonas por cantidad de
 * personas (zona libre, hamacas). El equipaje y la bodega no son tarifas de pasaje.
 */
export function layoutPriceClasses(doc: LayoutDocument, service: FareService): string[] {
  const zones = new Map(doc.zones.map((z) => [z.code, z]));
  const classes = new Set<string>();
  for (const r of deriveInventory(doc).resources) {
    if ((r.isSellable || r.sellableAsUnit) && zones.get(r.zoneCode)?.service === service) {
      classes.add(r.priceClassCode);
    }
  }
  if (service === 'PASSENGER') {
    for (const z of doc.zones) {
      const pooled = ZONE_RULES[z.kind].mode === 'POOLED';
      if (pooled && z.service === service && z.capacity.some((c) => c.dimension === 'PERSONS')) {
        classes.add(z.priceClassCode ?? ZONE_RULES[z.kind].priceClass);
      }
    }
  }
  return [...classes].sort();
}

/** Estado de una tarifa en la fecha `today` (AAAA-MM-DD). */
export function farePhase(
  f: { status: FareStatus; validFrom: string; validTo: string | null },
  today: string,
): FarePhase {
  if (f.status === 'CANCELLED') return 'CANCELLED';
  if (f.validFrom > today) return 'SCHEDULED';
  if (f.validTo !== null && f.validTo <= today) return 'ENDED';
  return 'CURRENT';
}
