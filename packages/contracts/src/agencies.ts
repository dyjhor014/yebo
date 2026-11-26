import { z } from 'zod';

/**
 * Fase 6.5 · Agencias externas (data-dictionary §3; F6-Q2). Solo el registro mínimo, detrás del módulo AGENCIES:
 * nombre, RUC, contacto y estado. Cada agencia nace con su canal de venta EXTERNAL_AGENCY. Las comisiones y los
 * usuarios de agencia llegan con la venta (Fase 8) y la liquidación (Fase 11), cuando D7 esté validado.
 */

/**
 * RUC peruano válido: 11 dígitos, prefijo de contribuyente (10, 15, 17 o 20) y dígito verificador (módulo 11 de
 * SUNAT, pesos 5, 4, 3, 2, 7, 6, 5, 4, 3, 2).
 */
export function isValidRuc(ruc: string): boolean {
  if (!/^(10|15|17|20)\d{9}$/.test(ruc)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(ruc[i]), 0);
  const check = (11 - (sum % 11)) % 10;
  return check === Number(ruc[10]);
}

export const RucSchema = z
  .string()
  .trim()
  .refine(
    isValidRuc,
    'RUC no válido: 11 dígitos que empiezan por 10, 15, 17 o 20, con su dígito verificador',
  );

const Text = (min: number, max: number) => z.string().trim().min(min).max(max);
const Optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), schema.nullable());

const AgencyFields = {
  name: Text(2, 80),
  /** Persona de contacto, teléfono y correo: opcionales (vacío = sin dato). */
  contactName: Optional(Text(2, 80)),
  contactPhone: Optional(
    z
      .string()
      .trim()
      .regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'Teléfono no válido'),
  ),
  contactEmail: Optional(z.string().trim().toLowerCase().pipe(z.email('Correo no válido').max(254))),
};

/** Alta: el RUC no cambia después (forma el código de su canal, `AGENCIA-<RUC>`). */
export const CreateAgencyRequestSchema = z.object({ taxId: RucSchema, ...AgencyFields }).strict();
export type CreateAgencyRequest = z.infer<typeof CreateAgencyRequestSchema>;

export const UpdateAgencyRequestSchema = z.object(AgencyFields).strict();
export type UpdateAgencyRequest = z.infer<typeof UpdateAgencyRequestSchema>;

export const AgencySchema = z.object({
  id: z.string(),
  name: z.string(),
  taxId: z.string(),
  contactName: z.string().nullable(),
  contactPhone: z.string().nullable(),
  contactEmail: z.string().nullable(),
  archived: z.boolean(),
  /** Su canal de venta EXTERNAL_AGENCY (inactivo mientras la agencia está archivada). */
  channel: z.object({ id: z.string(), code: z.string(), isActive: z.boolean() }),
});
export type Agency = z.infer<typeof AgencySchema>;

export const AgenciesResponseSchema = z.object({ agencies: z.array(AgencySchema) });
export type AgenciesResponse = z.infer<typeof AgenciesResponseSchema>;
