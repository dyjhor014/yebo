import { z } from 'zod';

/**
 * Fase 7.4 · Inventario por tramo (capacity-and-inventory §1–6; F7-Q5).
 * - Un viaje de la parada `a` a la `b` ocupa el rango semiabierto `[a, b)`: los tramos `a … b-1`.
 * - Recursos asignables (asiento, cama, camarote sin camas, espacio de vehículo): uno por titular en cada tramo.
 *   Un camarote con camas se ocupa por sus camas (pedir el camarote ocupa todas).
 * - Cupos por cantidad (zona libre, hamacas, bodega, aforo de la unidad): un contador por tramo que no supera la capacidad.
 * - En esta fase solo ocupan los **bloqueos operativos** (tripulación, mantenimiento, cortesía…); las ventas de la
 *   Fase 8 usan el mismo motor.
 */

export const BlockReasonSchema = z.enum(['CREW', 'MAINTENANCE', 'COURTESY', 'OTHER']);
export type BlockReason = z.infer<typeof BlockReasonSchema>;

/** Paradas por número de orden (`seq`): el bloqueo ocupa los tramos `fromSeq … toSeq-1`. */
export const CreateBlockRequestSchema = z
  .object({
    reason: BlockReasonSchema,
    note: z.string().trim().min(2).max(300).nullable(),
    fromSeq: z.number().int().min(0).max(48),
    toSeq: z.number().int().min(1).max(49),
    /** Códigos de recursos del viaje (`12A`, `C3`, `C3-B1`). Un camarote con camas ocupa todas sus camas. */
    resourceCodes: z.array(z.string().trim().min(1).max(40)).max(200),
    /** Cupos por cantidad: el id del pool del viaje y cuánto. */
    pools: z
      .array(z.object({ poolId: z.uuid(), quantity: z.number().positive().max(10_000_000) }).strict())
      .max(20),
    /** Con vencimiento, el bloqueo es una retención que se libera sola al vencer (ISO 8601, en el futuro). */
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.toSeq <= b.fromSeq) {
      ctx.addIssue({ code: 'custom', message: 'La parada final es posterior a la inicial', path: ['toSeq'] });
    }
    if (b.resourceCodes.length === 0 && b.pools.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Elige al menos un recurso o un cupo',
        path: ['resourceCodes'],
      });
    }
    if (new Set(b.resourceCodes).size !== b.resourceCodes.length) {
      ctx.addIssue({ code: 'custom', message: 'Recursos repetidos', path: ['resourceCodes'] });
    }
  });
export type CreateBlockRequest = z.infer<typeof CreateBlockRequestSchema>;

export const TripBlockSchema = z.object({
  id: z.string(),
  tripId: z.string(),
  reason: BlockReasonSchema,
  note: z.string().nullable(),
  fromSeq: z.number().int(),
  toSeq: z.number().int(),
  resourceCodes: z.array(z.string()),
  pools: z.array(z.object({ poolId: z.string(), quantity: z.number() })),
  expiresAt: z.string().nullable(),
  /** ACTIVE, EXPIRED (venció; su ocupación se libera al reasignar) o RELEASED. */
  state: z.enum(['ACTIVE', 'EXPIRED', 'RELEASED']),
  createdAt: z.string(),
  releasedAt: z.string().nullable(),
});
export type TripBlock = z.infer<typeof TripBlockSchema>;

export const TripBlocksResponseSchema = z.object({ blocks: z.array(TripBlockSchema) });
export type TripBlocksResponse = z.infer<typeof TripBlocksResponseSchema>;

/** Disponibilidad de un viaje tramo por tramo (las retenciones vencidas no ocupan). */
export const TripAvailabilitySchema = z.object({
  tripId: z.string(),
  status: z.string(),
  segments: z.array(z.object({ seq: z.number().int(), from: z.string(), to: z.string() })),
  resources: z.array(
    z.object({
      code: z.string(),
      kind: z.string(),
      zoneCode: z.string(),
      priceClassCode: z.string(),
      /** Libre en cada tramo (índice = número de tramo). Un camarote con camas está libre si todas lo están. */
      free: z.array(z.boolean()),
    }),
  ),
  pools: z.array(
    z.object({
      id: z.string(),
      scope: z.enum(['ZONE', 'VEHICLE']),
      zoneCode: z.string().nullable(),
      dimension: z.string(),
      capacity: z.number(),
      /** Ocupado y libre en cada tramo. */
      used: z.array(z.number()),
      free: z.array(z.number()),
    }),
  ),
});
export type TripAvailability = z.infer<typeof TripAvailabilitySchema>;
