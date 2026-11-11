import { z } from 'zod';

/**
 * Fase 6.2 · Flota (data-dictionary §4; F6-Q3, F6-Q5). Tipos de vehículo de cada empresa (con sugerencias de un
 * catálogo global), vehículos y sus documentos con vencimiento y archivo privado.
 */

export const MODALITIES = ['LAND', 'RIVER'] as const;
export const ModalitySchema = z.enum(MODALITIES);
export type Modality = z.infer<typeof ModalitySchema>;

const Text = (min: number, max: number) => z.string().trim().min(min).max(max);
/** Fecha de calendario `AAAA-MM-DD`. */
const IsoDate = z.iso.date();

// -----------------------------------------------------------------------------------------------------------------
// Tipos de vehículo
// -----------------------------------------------------------------------------------------------------------------

export const VehicleTypeInputSchema = z
  .object({
    name: Text(2, 60),
    modality: ModalitySchema,
    /** Sugerencia del catálogo global de la que parte (bus, lancha, motonave…), o ninguna. */
    catalogCode: z.string().max(24).nullable(),
  })
  .strict();
export type VehicleTypeInput = z.infer<typeof VehicleTypeInputSchema>;

/** Al editar un tipo, la modalidad no cambia (sus vehículos dependen de ella). */
export const UpdateVehicleTypeRequestSchema = VehicleTypeInputSchema.omit({ modality: true });
export type UpdateVehicleTypeRequest = z.infer<typeof UpdateVehicleTypeRequestSchema>;

export const VehicleTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  modality: ModalitySchema,
  catalogCode: z.string().nullable(),
  archived: z.boolean(),
  /** Vehículos no retirados de este tipo (no se archiva mientras tenga alguno). */
  activeVehicles: z.number().int().nonnegative(),
});
export type VehicleType = z.infer<typeof VehicleTypeSchema>;

export const VehicleTypesResponseSchema = z.object({
  catalog: z.array(z.object({ code: z.string(), name: z.string(), modality: ModalitySchema })),
  types: z.array(VehicleTypeSchema),
});
export type VehicleTypesResponse = z.infer<typeof VehicleTypesResponseSchema>;

// -----------------------------------------------------------------------------------------------------------------
// Vehículos
// -----------------------------------------------------------------------------------------------------------------

export const VEHICLE_STATUSES = ['ACTIVE', 'MAINTENANCE', 'OUT_OF_SERVICE', 'RETIRED'] as const;
export const VehicleStatusSchema = z.enum(VEHICLE_STATUSES);
export type VehicleStatus = z.infer<typeof VehicleStatusSchema>;

/** F6-Q3: solo si es propia o de terceros; los propietarios y las liquidaciones esperan a validar D6. */
export const VehicleOwnershipSchema = z.enum(['OWN', 'THIRD_PARTY']);
export type VehicleOwnership = z.infer<typeof VehicleOwnershipSchema>;

/** Código interno del vehículo: no cambia después de crearlo (lo usarán los viajes). */
export const VehicleCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,15}$/, 'Usa hasta 16 letras, números o guiones');

/** Placa o matrícula, en mayúsculas: `ABC-123`, `PA-12345-EM`. */
export const RegistrationSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9 -]{2,19}$/, 'Placa o matrícula no válida');

/** Capacidad nominal (la de la tarjeta o el certificado); la capacidad vendible la definen los layouts (6.3). */
export const NominalCapacitySchema = z
  .object({
    passengers: z.number().int().min(0).max(5000).nullable(),
    weightKg: z.number().min(0).max(10_000_000).nullable(),
    volumeM3: z.number().min(0).max(100_000).nullable(),
  })
  .strict();
export type NominalCapacity = z.infer<typeof NominalCapacitySchema>;

const VehicleFields = {
  name: Text(2, 80),
  vehicleTypeId: z.uuid(),
  registration: RegistrationSchema,
  status: VehicleStatusSchema,
  ownership: VehicleOwnershipSchema,
  nominalCapacity: NominalCapacitySchema,
  features: z.array(Text(2, 60)).max(20),
};

export const CreateVehicleRequestSchema = z.object({ code: VehicleCodeSchema, ...VehicleFields }).strict();
export type CreateVehicleRequest = z.infer<typeof CreateVehicleRequestSchema>;

export const UpdateVehicleRequestSchema = z.object(VehicleFields).strict();
export type UpdateVehicleRequest = z.infer<typeof UpdateVehicleRequestSchema>;

// -----------------------------------------------------------------------------------------------------------------
// Documentos
// -----------------------------------------------------------------------------------------------------------------

/** Días antes del vencimiento en que un documento pasa a «por vencer». */
export const DOCUMENT_EXPIRING_DAYS = 30;

export const DocumentStatusSchema = z.enum(['VALID', 'EXPIRING', 'EXPIRED', 'NO_EXPIRY']);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

/** Resumen de los documentos de un vehículo: el peor estado entre el documento vigente de cada tipo. */
export const DocumentsSummarySchema = z.enum(['OK', 'EXPIRING', 'EXPIRED', 'NONE']);
export type DocumentsSummary = z.infer<typeof DocumentsSummarySchema>;

export const VehicleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  vehicleTypeId: z.string(),
  vehicleTypeName: z.string(),
  modality: ModalitySchema,
  registration: z.string(),
  status: VehicleStatusSchema,
  ownership: VehicleOwnershipSchema,
  nominalCapacity: NominalCapacitySchema,
  features: z.array(z.string()),
  documents: DocumentsSummarySchema,
  /** Próximo vencimiento entre los documentos vigentes, o `null`. */
  nextExpiry: IsoDate.nullable(),
});
export type Vehicle = z.infer<typeof VehicleSchema>;

export const VehiclesResponseSchema = z.object({ vehicles: z.array(VehicleSchema) });
export type VehiclesResponse = z.infer<typeof VehiclesResponseSchema>;

export const VehicleDocumentInputSchema = z
  .object({
    typeCode: z.string().min(2).max(24),
    number: Text(1, 40),
    issuedOn: IsoDate.nullable(),
    expiresOn: IsoDate.nullable(),
    /** Archivo subido antes con `POST /vehicle-documents/files` (PDF, JPEG o PNG; privado). */
    fileAssetId: z.uuid().nullable(),
  })
  .strict()
  .refine((d) => !d.issuedOn || !d.expiresOn || d.expiresOn >= d.issuedOn, {
    message: 'El vencimiento no puede ser anterior a la emisión',
    path: ['expiresOn'],
  });
export type VehicleDocumentInput = z.infer<typeof VehicleDocumentInputSchema>;

export const VehicleDocumentFileSchema = z.object({
  id: z.string(),
  mime: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
  sizeBytes: z.number().int().positive(),
});
export type VehicleDocumentFile = z.infer<typeof VehicleDocumentFileSchema>;

export const VehicleDocumentSchema = z.object({
  id: z.string(),
  typeCode: z.string(),
  typeName: z.string(),
  number: z.string(),
  issuedOn: IsoDate.nullable(),
  expiresOn: IsoDate.nullable(),
  status: DocumentStatusSchema,
  file: VehicleDocumentFileSchema.nullable(),
  archived: z.boolean(),
});
export type VehicleDocument = z.infer<typeof VehicleDocumentSchema>;

export const VehicleDocumentsResponseSchema = z.object({
  /** Tipos de documento que aplican a la modalidad del vehículo. */
  types: z.array(z.object({ code: z.string(), name: z.string() })),
  documents: z.array(VehicleDocumentSchema),
});
export type VehicleDocumentsResponse = z.infer<typeof VehicleDocumentsResponseSchema>;

/** Días entre dos fechas de calendario `AAAA-MM-DD` (b − a). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Estado de un documento en la fecha `today` de la empresa: vence el mismo día de `expiresOn` (aún vigente). */
export function documentStatus(expiresOn: string | null, today: string): DocumentStatus {
  if (!expiresOn) return 'NO_EXPIRY';
  const left = daysBetween(today, expiresOn);
  if (left < 0) return 'EXPIRED';
  return left <= DOCUMENT_EXPIRING_DAYS ? 'EXPIRING' : 'VALID';
}

/**
 * Resumen de un vehículo: de cada tipo cuenta el documento VIGENTE, el de vencimiento más lejano (una renovación
 * deja al anterior como historia, sin que haga falta archivarlo), y el resumen es el peor de ellos.
 */
export function documentsSummary(
  documents: readonly { typeCode: string; expiresOn: string | null }[],
  today: string,
): { summary: DocumentsSummary; nextExpiry: string | null } {
  const current = new Map<string, string | null>();
  for (const d of documents) {
    const seen = current.get(d.typeCode);
    if (seen === undefined) current.set(d.typeCode, d.expiresOn);
    else if (seen !== null && (d.expiresOn === null || d.expiresOn > seen))
      current.set(d.typeCode, d.expiresOn);
  }
  if (current.size === 0) return { summary: 'NONE', nextExpiry: null };
  const statuses = [...current.values()].map((e) => documentStatus(e, today));
  const summary = statuses.includes('EXPIRED')
    ? 'EXPIRED'
    : statuses.includes('EXPIRING')
      ? 'EXPIRING'
      : 'OK';
  const upcoming = [...current.values()].filter((e): e is string => e !== null && e >= today).sort();
  return { summary, nextExpiry: upcoming[0] ?? null };
}
