import { z } from 'zod';

/**
 * GET /api/v1/public/site — información pública del tenant resuelto por el host (ADR-004).
 * Fase 3.1: identidad mínima de la empresa. El tema publicado y los servicios habilitados se
 * añaden en la Fase 5 (white label) sin romper este contrato.
 */
export const PublicSiteResponseSchema = z.object({
  tenant: z.object({
    slug: z.string(),
    tradeName: z.string(),
  }),
});
export type PublicSiteResponse = z.infer<typeof PublicSiteResponseSchema>;
