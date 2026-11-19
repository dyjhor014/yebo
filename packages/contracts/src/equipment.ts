import { z } from 'zod';
import { ModalitySchema } from './fleet';

/**
 * Fase 7.E1 · Equipamiento de unidades e inspecciones preoperacionales (plan-equipamiento-inspecciones; EQ-Q1–Q10).
 * Herramienta OPCIONAL de control interno: ninguna regla de viajes, venta, asignación ni salida depende de ella. No
 * reemplaza las inspecciones ni las certificaciones de la autoridad (MTC, DICAPI).
 */
export const INSPECTION_DISCLAIMER =
  'Herramienta de control interno; no reemplaza las inspecciones ni certificaciones de la autoridad.';

export const EQUIPMENT_LIMITS = {
  /** Elementos activos por unidad. */
  perVehicle: 200,
  /** Elementos por envío al declarar. */
  perRequest: 100,
  /** Fotos por elemento inspeccionado y fotos generales por inspección. */
  photosPerItem: 5,
  photosGeneral: 10,
  /** Tamaño máximo de una foto (se recodifica a JPEG sin metadatos). */
  photoMaxBytes: 5 * 1024 * 1024,
} as const;

export const EquipmentCategorySchema = z.enum(['SAFETY', 'EMERGENCY', 'OPERATION']);
export type EquipmentCategory = z.infer<typeof EquipmentCategorySchema>;
export const EquipmentStatusSchema = z.enum(['OPERATIVE', 'DETERIORATED', 'INOPERATIVE', 'UNVERIFIED']);
export type EquipmentStatus = z.infer<typeof EquipmentStatusSchema>;
export const InspectionStatusSchema = z.enum(['DRAFT', 'COMPLETED', 'COMPLETED_WITH_OBSERVATIONS']);
export type InspectionStatus = z.infer<typeof InspectionStatusSchema>;
export const InspectionResultSchema = z.enum(['CONFORMING', 'OBSERVED', 'NOT_OPERATIONAL', 'NOT_AVAILABLE']);
export type InspectionResult = z.infer<typeof InspectionResultSchema>;

const Name = z.string().trim().min(2).max(80);
const OptText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v === '' ? null : v));
const IsoDate = z.iso.date();

// ---------------------------------------------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------------------------------------------

export const EquipmentCatalogEntrySchema = z.object({
  /** `CATALOG` (sugerencia de YEBO, por código) o `TENANT` (de la empresa, por id). */
  source: z.enum(['CATALOG', 'TENANT']),
  /** Código del catálogo de YEBO o id del elemento de la empresa. */
  ref: z.string(),
  name: z.string(),
  /** Null: general (sirve para cualquier modalidad). */
  modality: ModalitySchema.nullable(),
  category: EquipmentCategorySchema,
  tracksExpiry: z.boolean(),
  tracksSerial: z.boolean(),
  /** Referencia normativa ORIENTATIVA (solo en el catálogo de YEBO). */
  reference: z.string().nullable(),
  description: z.string().nullable(),
  archived: z.boolean(),
});
export type EquipmentCatalogEntry = z.infer<typeof EquipmentCatalogEntrySchema>;

export const EquipmentCatalogResponseSchema = z.object({
  disclaimer: z.string(),
  entries: z.array(EquipmentCatalogEntrySchema),
});
export type EquipmentCatalogResponse = z.infer<typeof EquipmentCatalogResponseSchema>;

export const TenantEquipmentItemRequestSchema = z
  .object({
    name: Name,
    modality: ModalitySchema.nullable(),
    category: EquipmentCategorySchema,
    tracksExpiry: z.boolean(),
    tracksSerial: z.boolean(),
    description: OptText(300),
  })
  .strict();
export type TenantEquipmentItemRequest = z.infer<typeof TenantEquipmentItemRequestSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Equipamiento de una unidad
// ---------------------------------------------------------------------------------------------------------------

const equipmentFields = {
  name: Name,
  category: EquipmentCategorySchema,
  quantity: z.number().int().min(1).max(100_000),
  description: OptText(300),
  status: EquipmentStatusSchema,
  expiresOn: IsoDate.nullable(),
  serialNumber: OptText(60),
};

export const VehicleEquipmentInputSchema = z
  .object({
    ...equipmentFields,
    /** De dónde viene (opcional): un código del catálogo de YEBO o un elemento de la empresa, no ambos. */
    catalogCode: z.string().nullable(),
    tenantItemId: z.uuid().nullable(),
  })
  .strict()
  .refine((e) => e.catalogCode === null || e.tenantItemId === null, {
    message: 'El elemento viene del catálogo de YEBO o del de la empresa, no de ambos',
    path: ['tenantItemId'],
  });
export type VehicleEquipmentInput = z.infer<typeof VehicleEquipmentInputSchema>;

/** Declarar uno o varios elementos de una vez (p. ej., al crear la unidad). */
export const AddVehicleEquipmentRequestSchema = z
  .object({ items: z.array(VehicleEquipmentInputSchema).min(1).max(EQUIPMENT_LIMITS.perRequest) })
  .strict();
export type AddVehicleEquipmentRequest = z.infer<typeof AddVehicleEquipmentRequestSchema>;

/** Editar un elemento: su origen y su unidad no cambian. */
export const UpdateVehicleEquipmentRequestSchema = z.object(equipmentFields).strict();
export type UpdateVehicleEquipmentRequest = z.infer<typeof UpdateVehicleEquipmentRequestSchema>;

export const VehicleEquipmentSchema = z.object({
  id: z.string(),
  vehicleId: z.string(),
  catalogCode: z.string().nullable(),
  tenantItemId: z.string().nullable(),
  name: z.string(),
  category: EquipmentCategorySchema,
  quantity: z.number().int(),
  description: z.string().nullable(),
  status: EquipmentStatusSchema,
  expiresOn: z.string().nullable(),
  serialNumber: z.string().nullable(),
  /** Vencido o por vencer (30 días) según el calendario de la empresa; null sin fecha. */
  expiry: z.enum(['VALID', 'EXPIRING', 'EXPIRED']).nullable(),
  archived: z.boolean(),
});
export type VehicleEquipment = z.infer<typeof VehicleEquipmentSchema>;

export const VehicleEquipmentResponseSchema = z.object({ equipment: z.array(VehicleEquipmentSchema) });
export type VehicleEquipmentResponse = z.infer<typeof VehicleEquipmentResponseSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Inspecciones
// ---------------------------------------------------------------------------------------------------------------

/** Nueva inspección (borrador) de una unidad, con viaje opcional; o una rectificación de una completada. */
export const CreateInspectionRequestSchema = z
  .object({
    vehicleId: z.uuid(),
    tripId: z.uuid().nullable(),
    rectifiesId: z.uuid().nullable(),
    rectificationReason: OptText(300),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.rectifiesId === null) !== (r.rectificationReason === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Una rectificación indica la inspección que corrige y el motivo',
        path: ['rectificationReason'],
      });
    }
    if (r.rectificationReason !== null && r.rectificationReason.length < 3) {
      ctx.addIssue({
        code: 'custom',
        message: 'El motivo tiene al menos 3 caracteres',
        path: ['rectificationReason'],
      });
    }
  });
export type CreateInspectionRequest = z.infer<typeof CreateInspectionRequestSchema>;

export const UpdateInspectionRequestSchema = z.object({ generalNotes: OptText(2000) }).strict();
export type UpdateInspectionRequest = z.infer<typeof UpdateInspectionRequestSchema>;

/** Resultado de un elemento (borrador). Null deja el elemento sin marcar. */
export const UpdateInspectionItemRequestSchema = z
  .object({
    result: InspectionResultSchema.nullable(),
    foundQuantity: z.number().int().min(0).max(100_000).nullable(),
    observation: OptText(500),
  })
  .strict();
export type UpdateInspectionItemRequest = z.infer<typeof UpdateInspectionItemRequestSchema>;

/** Resultado sugerido (EQ-Q10): si se encontró menos de lo declarado, «Observado»; la persona decide. */
export function suggestedResult(declared: number, found: number | null): InspectionResult | null {
  if (found === null) return null;
  if (found === 0) return 'NOT_AVAILABLE';
  return found < declared ? 'OBSERVED' : 'CONFORMING';
}

export const InspectionCountsSchema = z.object({
  conforming: z.number().int(),
  observed: z.number().int(),
  notOperational: z.number().int(),
  notAvailable: z.number().int(),
});
export type InspectionCounts = z.infer<typeof InspectionCountsSchema>;

const Actor = z.object({
  kind: z.enum(['MEMBERSHIP', 'PLATFORM_USER']),
  id: z.string(),
  name: z.string().nullable(),
});

export const InspectionSummarySchema = z.object({
  id: z.string(),
  vehicleId: z.string(),
  vehicleCode: z.string(),
  vehicleName: z.string(),
  trip: z.object({ id: z.string(), code: z.string() }).nullable(),
  status: InspectionStatusSchema,
  startedAt: z.string(),
  startedBy: Actor,
  completedAt: z.string().nullable(),
  completedBy: Actor.nullable(),
  /** Null en borrador; al completar, los conteos quedan fijos. */
  counts: InspectionCountsSchema.nullable(),
  items: z.number().int(),
  rectifiesId: z.string().nullable(),
  /** Rectificaciones completadas que corrigen a esta. */
  rectifiedBy: z.array(z.string()),
});
export type InspectionSummary = z.infer<typeof InspectionSummarySchema>;

export const InspectionPhotoSchema = z.object({
  id: z.string(),
  itemId: z.string().nullable(),
  createdAt: z.string(),
});

export const InspectionItemSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  vehicleEquipmentId: z.string().nullable(),
  name: z.string(),
  category: EquipmentCategorySchema,
  declaredQuantity: z.number().int(),
  declaredStatus: EquipmentStatusSchema,
  serialNumber: z.string().nullable(),
  expiresOn: z.string().nullable(),
  result: InspectionResultSchema.nullable(),
  foundQuantity: z.number().int().nullable(),
  observation: z.string().nullable(),
});
export type InspectionItem = z.infer<typeof InspectionItemSchema>;

export const InspectionDetailSchema = InspectionSummarySchema.extend({
  vehicleRegistration: z.string(),
  generalNotes: z.string().nullable(),
  rectificationReason: z.string().nullable(),
  items: z.array(InspectionItemSchema),
  photos: z.array(InspectionPhotoSchema),
  disclaimer: z.string(),
});
export type InspectionDetail = z.infer<typeof InspectionDetailSchema>;

export const InspectionsResponseSchema = z.object({ inspections: z.array(InspectionSummarySchema) });
export type InspectionsResponse = z.infer<typeof InspectionsResponseSchema>;

/** «Control preoperacional» de un viaje: sus inspecciones y la última completada de su unidad (si hay). */
export const TripInspectionsResponseSchema = z.object({
  tripId: z.string(),
  vehicleId: z.string().nullable(),
  inspections: z.array(InspectionSummarySchema),
  latestForVehicle: InspectionSummarySchema.nullable(),
  disclaimer: z.string(),
});
export type TripInspectionsResponse = z.infer<typeof TripInspectionsResponseSchema>;
