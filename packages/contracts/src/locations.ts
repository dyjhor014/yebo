import { z } from 'zod';

/**
 * Fase 6.1 · Ubicaciones, sucursales y canales de venta (data-dictionary §3; F6-Q4, F6-Q6 y F6-Q7).
 * Las ubicaciones son de cada empresa, con el ubigeo del INEI opcional para relacionarlas entre empresas más
 * adelante (F6-Q6). Los tipos (ciudad, puerto, embarcadero, terminal) son un catálogo global.
 */

/** Tipos de ubicación del catálogo global (`location_kinds`). La migración siembra exactamente estos. */
export const LOCATION_KINDS = ['CITY', 'PORT', 'LANDING', 'TERMINAL'] as const;
export const LocationKindSchema = z.enum(LOCATION_KINDS);
export type LocationKind = z.infer<typeof LocationKindSchema>;

const Text = (min: number, max: number) => z.string().trim().min(min).max(max);
const Phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'Teléfono no válido');

export const LocationInputSchema = z
  .object({
    name: Text(2, 80),
    kind: LocationKindSchema,
    /** Código de ubigeo del INEI (distrito): 6 dígitos. */
    ubigeo: z
      .string()
      .regex(/^\d{6}$/, 'El ubigeo tiene 6 dígitos')
      .nullable(),
    region: Text(2, 60).nullable(),
    /** Coordenadas opcionales; van juntas. */
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
  })
  .strict()
  .refine((l) => (l.lat === null) === (l.lng === null), {
    message: 'Indica latitud y longitud, o ninguna',
    path: ['lng'],
  });
export type LocationInput = z.infer<typeof LocationInputSchema>;

export const LocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: LocationKindSchema,
  ubigeo: z.string().nullable(),
  region: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  archived: z.boolean(),
  /** Sucursales activas en esta ubicación (no se archiva mientras tenga alguna). */
  activeBranches: z.number().int().nonnegative(),
});
export type Location = z.infer<typeof LocationSchema>;

export const LocationsResponseSchema = z.object({
  kinds: z.array(z.object({ code: LocationKindSchema, name: z.string() })),
  locations: z.array(LocationSchema),
});
export type LocationsResponse = z.infer<typeof LocationsResponseSchema>;

/** Código de sucursal: mayúsculas, números y guion; no cambia después de crearla (lo usa su canal de mostrador). */
export const BranchCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,11}$/, 'Usa hasta 12 letras, números o guiones');

const BranchFields = {
  locationId: z.uuid(),
  name: Text(2, 80),
  address: Text(3, 200),
  phones: z.array(Phone).max(4),
  /** Punto donde el cliente recoge encomiendas. */
  isPickupPoint: z.boolean(),
  /** Punto donde se reciben encomiendas para enviar. */
  isReceptionPoint: z.boolean(),
};

export const CreateBranchRequestSchema = z.object({ code: BranchCodeSchema, ...BranchFields }).strict();
export type CreateBranchRequest = z.infer<typeof CreateBranchRequestSchema>;

export const UpdateBranchRequestSchema = z.object(BranchFields).strict();
export type UpdateBranchRequest = z.infer<typeof UpdateBranchRequestSchema>;

export const BranchSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  address: z.string(),
  phones: z.array(z.string()),
  isPickupPoint: z.boolean(),
  isReceptionPoint: z.boolean(),
  archived: z.boolean(),
});
export type Branch = z.infer<typeof BranchSchema>;

export const BranchesResponseSchema = z.object({ branches: z.array(BranchSchema) });
export type BranchesResponse = z.infer<typeof BranchesResponseSchema>;

/** Canales de venta (ADR-020: siempre activos). Las ventas registran el canal desde el día 1. */
export const SALES_CHANNEL_KINDS = ['COUNTER', 'ONLINE', 'EXTERNAL_AGENCY', 'CALL_CENTER', 'API'] as const;
export const SalesChannelKindSchema = z.enum(SALES_CHANNEL_KINDS);
export type SalesChannelKind = z.infer<typeof SalesChannelKindSchema>;

export const SalesChannelSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  kind: SalesChannelKindSchema,
  branchId: z.string().nullable(),
  isActive: z.boolean(),
});
export type SalesChannel = z.infer<typeof SalesChannelSchema>;

export const SalesChannelsResponseSchema = z.object({ channels: z.array(SalesChannelSchema) });
export type SalesChannelsResponse = z.infer<typeof SalesChannelsResponseSchema>;

export const UpdateSalesChannelRequestSchema = z
  .object({ name: Text(2, 80), isActive: z.boolean() })
  .strict();
export type UpdateSalesChannelRequest = z.infer<typeof UpdateSalesChannelRequestSchema>;

/**
 * Sucursales de una persona (F6-Q4): sin ninguna, accede a todas. Se guarda y se muestra en esta fase; se aplica
 * a partir de la venta (Fase 8).
 */
export const AssignBranchesRequestSchema = z
  .object({
    branchIds: z
      .array(z.uuid())
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Sucursales repetidas' }),
  })
  .strict();
export type AssignBranchesRequest = z.infer<typeof AssignBranchesRequestSchema>;

export const AssignBranchesResponseSchema = z.object({
  membershipId: z.string(),
  branchIds: z.array(z.string()),
});
export type AssignBranchesResponse = z.infer<typeof AssignBranchesResponseSchema>;
