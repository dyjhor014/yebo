import { z } from 'zod';

export const DependencyStatusSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative().optional(),
  message: z.string().optional(),
});

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  service: z.enum(['api', 'worker']),
  version: z.string(),
  checks: z.record(z.string(), DependencyStatusSchema),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
