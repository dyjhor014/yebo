import { z } from 'zod';
import { SiteConfigSchema } from './site';
import { ServiceModalitySchema, TransportServiceSchema } from './tenants';

/**
 * GET /api/v1/public/site — información pública del tenant resuelto por el host (ADR-004).
 * Fase 3.1: identidad mínima de la empresa. Fase 5.1: el sitio publicado (ya con lo que permite el plan aplicado:
 * F5-Q4) y los servicios que opera. Solo se AÑADEN campos: el contrato anterior sigue siendo válido. No dice si el
 * plan incluye WHITE_LABEL (dato comercial que el portal no necesita).
 */
export const PublicSiteResponseSchema = z.object({
  tenant: z.object({
    slug: z.string(),
    tradeName: z.string(),
  }),
  site: z.object({
    /** Versión publicada; `null` = la empresa aún no publicó (se muestra la configuración por defecto). */
    version: z.number().int().positive().nullable(),
    config: SiteConfigSchema,
  }),
  services: z.array(z.object({ modality: ServiceModalitySchema, service: TransportServiceSchema })),
});
export type PublicSiteResponse = z.infer<typeof PublicSiteResponseSchema>;
