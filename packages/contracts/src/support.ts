import { z } from 'zod';

/**
 * Acceso de soporte del staff de YEBO a una empresa (Fase 4.6): temporal (≤ 8 h), con motivo, visible para la
 * empresa, aprobable si la empresa lo exige y revocable. READ_ONLY = solo consultas.
 */
export const SupportScopeSchema = z.enum(['READ_ONLY', 'FULL']);

export const CreateSupportGrantRequestSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
    scope: SupportScopeSchema,
    durationMinutes: z.number().int().min(15).max(480).default(120),
  })
  .strict();
export type CreateSupportGrantRequest = z.infer<typeof CreateSupportGrantRequestSchema>;

export const SupportGrantStatusSchema = z.enum(['PENDING_APPROVAL', 'ACTIVE', 'EXPIRED', 'REVOKED']);

export const SupportGrantSchema = z.object({
  id: z.string(),
  staffName: z.string(),
  staffEmail: z.string(),
  reason: z.string(),
  scope: SupportScopeSchema,
  status: SupportGrantStatusSchema,
  startsAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  requiresApproval: z.boolean(),
  approvedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: z.enum(['PLATFORM_USER', 'MEMBERSHIP']).nullable(),
  /** Cada petición del staff en la empresa: cuándo, método y ruta (sin datos). */
  accesses: z.array(z.object({ occurredAt: z.iso.datetime(), method: z.string(), route: z.string() })),
});
export type SupportGrant = z.infer<typeof SupportGrantSchema>;
export const SupportGrantsResponseSchema = z.object({ grants: z.array(SupportGrantSchema) });
export type SupportGrantsResponse = z.infer<typeof SupportGrantsResponseSchema>;

/** Panel: enlace de un solo uso (60 s) que abre la sesión de soporte en el host de la empresa. */
export const SupportHandoffResponseSchema = z.object({ url: z.string(), expiresAt: z.iso.datetime() });
export type SupportHandoffResponse = z.infer<typeof SupportHandoffResponseSchema>;

/** Empresa: exigir o no la aprobación de cada acceso de soporte. */
export const SupportSettingsSchema = z.object({ requiresApproval: z.boolean() }).strict();
export type SupportSettings = z.infer<typeof SupportSettingsSchema>;
