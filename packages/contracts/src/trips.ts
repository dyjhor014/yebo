import { z } from 'zod';
import { ModalitySchema } from './fleet';

/**
 * Fase 7.3a · Viajes (data-dictionary §5; F7-Q3, F7-Q4 y F7-Q6).
 * - Un viaje es una salida de una ruta en una fecha y hora **locales de la empresa** (`AAAA-MM-DDTHH:mm`). Copia las
 *   paradas de la ruta con sus horas: editar la ruta no cambia los viajes ya creados.
 * - Unidad y plano (F7-Q3): un vehículo de la modalidad de la ruta y, si no se elige otro, el plano que tiene asignado
 *   el día de la salida. Al fijarlos se materializa el inventario (recursos y pools); al abrir la venta, un contador
 *   por pool y tramo. Desde la apertura, la unidad, el plano y las horas quedan fijos.
 * - Estados de esta fase (F7-Q4): PLANNED → OPEN_FOR_SALE (y de vuelta, sin ocupación) y CANCELLED (con motivo,
 *   sin ocupación). Solo viajes compartidos; los privados y el mínimo de pasajeros con su plazo se aplican en la
 *   Fase 8 (F7-Q6): aquí solo se guardan.
 */

/** Fecha y hora locales sin zona: `2026-12-01T08:30`. */
export const LocalDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'Fecha y hora en formato AAAA-MM-DDTHH:mm')
  .refine((v) => {
    const d = new Date(`${v.slice(0, 10)}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v.slice(0, 10);
  }, 'Fecha no válida');

/** Días hacia adelante en que se puede crear un viaje. */
export const TRIP_MAX_DAYS_AHEAD = 400;
/** Días que abarca como mucho una consulta de viajes por fechas. */
export const TRIPS_QUERY_MAX_DAYS = 62;

export const TripStatusSchema = z.enum([
  'PLANNED',
  'OPEN_FOR_SALE',
  'CONFIRMED',
  'BOARDING',
  'DEPARTED',
  'ARRIVED',
  'CLOSED',
  'CANCELLED',
]);
export type TripStatus = z.infer<typeof TripStatusSchema>;

const LayoutRef = z.object({ layoutId: z.uuid(), version: z.number().int().min(1) }).strict();

const tripFields = {
  departureLocal: LocalDateTimeSchema,
  /** Null: el viaje aún no tiene unidad (no se puede abrir a la venta). */
  vehicleId: z.uuid().nullable(),
  /** Null: el plano que el vehículo tiene asignado el día de la salida (si tiene). */
  layout: LayoutRef.nullable(),
  /** F7-Q6: se guardan; confirmar o cancelar por mínimo llega con la Fase 8. */
  minPassengers: z.number().int().min(1).max(1000).nullable(),
  confirmationDeadlineLocal: LocalDateTimeSchema.nullable(),
};

const tripRules = (
  t: {
    vehicleId: string | null;
    layout: unknown;
    departureLocal: string;
    confirmationDeadlineLocal: string | null;
  },
  ctx: z.RefinementCtx,
) => {
  if (t.layout !== null && t.vehicleId === null) {
    ctx.addIssue({ code: 'custom', message: 'Elige la unidad antes que el plano', path: ['layout'] });
  }
  if (t.confirmationDeadlineLocal !== null && t.confirmationDeadlineLocal >= t.departureLocal) {
    ctx.addIssue({
      code: 'custom',
      message: 'El plazo de confirmación es anterior a la salida',
      path: ['confirmationDeadlineLocal'],
    });
  }
};

export const CreateTripRequestSchema = z
  .object({ routeId: z.uuid(), ...tripFields })
  .strict()
  .superRefine(tripRules);
export type CreateTripRequest = z.infer<typeof CreateTripRequestSchema>;

/** Solo con el viaje planificado: la salida (recalcula las horas de las paradas), la unidad, el plano y el mínimo. */
export const UpdateTripRequestSchema = z.object(tripFields).strict().superRefine(tripRules);
export type UpdateTripRequest = z.infer<typeof UpdateTripRequestSchema>;

export const CancelTripRequestSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
export type CancelTripRequest = z.infer<typeof CancelTripRequestSchema>;

/** Viajes con salida local entre `from` y `to` (inclusive), hasta TRIPS_QUERY_MAX_DAYS días. */
export const TripsQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    routeId: z.uuid().optional(),
    status: TripStatusSchema.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
    if (days < 0)
      ctx.addIssue({ code: 'custom', message: 'El fin es igual o posterior al inicio', path: ['to'] });
    if (days >= TRIPS_QUERY_MAX_DAYS) {
      ctx.addIssue({
        code: 'custom',
        message: `Hasta ${TRIPS_QUERY_MAX_DAYS} días por consulta`,
        path: ['to'],
      });
    }
  });
export type TripsQuery = z.infer<typeof TripsQuerySchema>;

export const TripStopSchema = z.object({
  seq: z.number().int(),
  locationId: z.string(),
  locationName: z.string(),
  /** Horas locales de la empresa (`AAAA-MM-DDTHH:mm`): el origen no tiene llegada y el destino no tiene salida. */
  arrivalLocal: z.string().nullable(),
  departureLocal: z.string().nullable(),
  allowsBoarding: z.boolean(),
  allowsAlighting: z.boolean(),
});
export type TripStop = z.infer<typeof TripStopSchema>;

export const TripPoolSchema = z.object({
  id: z.string(),
  scope: z.enum(['ZONE', 'VEHICLE']),
  zoneCode: z.string().nullable(),
  dimension: z.string(),
  capacity: z.number(),
});
export type TripPool = z.infer<typeof TripPoolSchema>;

export const TripSchema = z.object({
  id: z.string(),
  code: z.string(),
  routeId: z.string(),
  routeCode: z.string(),
  routeName: z.string(),
  modality: ModalitySchema,
  departureKind: z.enum(['SCHEDULED', 'ON_DEMAND']),
  serviceMode: z.enum(['SHARED', 'PRIVATE']),
  status: TripStatusSchema,
  departureLocal: z.string(),
  arrivalLocal: z.string(),
  /** Instantes en UTC (ISO 8601). */
  plannedDepartureAt: z.string(),
  plannedArrivalAt: z.string(),
  vehicle: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  layout: z.object({ layoutId: z.string(), name: z.string(), version: z.number().int() }).nullable(),
  minPassengers: z.number().int().nullable(),
  confirmationDeadlineLocal: z.string().nullable(),
  stops: z.array(TripStopSchema),
  /** Inventario materializado (null sin plano): recursos vendibles y pools. */
  inventory: z
    .object({
      resources: z.number().int(),
      sellableResources: z.number().int(),
      pools: z.array(TripPoolSchema),
      /** Contadores por tramo (pools × tramos) creados al abrir la venta. */
      segmentRows: z.number().int(),
    })
    .nullable(),
  openedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
});
export type Trip = z.infer<typeof TripSchema>;

export const TripsResponseSchema = z.object({ trips: z.array(TripSchema) });
export type TripsResponse = z.infer<typeof TripsResponseSchema>;

/** Inventario completo del viaje: recursos, pools y, si está a la venta, sus contadores por tramo. */
export const TripInventorySchema = z.object({
  tripId: z.string(),
  segments: z.array(z.object({ seq: z.number().int(), from: z.string(), to: z.string() })),
  resources: z.array(
    z.object({
      code: z.string(),
      kind: z.string(),
      zoneCode: z.string(),
      parentCode: z.string().nullable(),
      priceClassCode: z.string(),
      capacity: z.number().int(),
      isSellable: z.boolean(),
      sellableAsUnit: z.boolean(),
    }),
  ),
  pools: z.array(
    TripPoolSchema.extend({
      usage: z.array(z.object({ seq: z.number().int(), capacity: z.number(), used: z.number() })),
    }),
  ),
});
export type TripInventory = z.infer<typeof TripInventorySchema>;

/** Código del viaje: ruta, fecha y hora locales (`PCL-IQT-261201-0830`). Con repetidos (cancelados), `-2`, `-3`… */
export function tripCode(routeCode: string, departureLocal: string): string {
  const [date = '', time = ''] = departureLocal.split('T');
  return `${routeCode}-${date.slice(2).replaceAll('-', '')}-${time.replace(':', '')}`;
}
