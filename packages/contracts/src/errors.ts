import { z } from 'zod';

/**
 * Códigos de error estables expuestos por la API.
 * El cliente decide su comportamiento por `code`, nunca por el texto del mensaje.
 */
export const ErrorCode = z.enum([
  'VALIDATION_FAILED',
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  /** El token se emitió con otra versión de permisos: el cliente lo renueva en silencio (identity-and-sessions §7). */
  'PERMISSIONS_CHANGED',
  'FORBIDDEN',
  /** El estado del tenant (suspendido, vencido, cancelado) no permite esta operación (ADR-023, multitenancy §5). */
  'TENANT_RESTRICTED',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ValidationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  code: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/** Formato único de error de la API (system-overview §6, api-conventions). */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    traceId: z.string(),
    issues: z.array(ValidationIssueSchema).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
