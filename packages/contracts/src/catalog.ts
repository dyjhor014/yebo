import { z } from 'zod';

/**
 * Catálogo comercial (Fase 4.2): módulos, planes, versiones y excepciones de módulo. Los importes viajan como TEXTO
 * decimal ("99.00") para no perder precisión; ningún precio está fijado por el sistema.
 */
export const MoneySchema = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Importe con hasta 2 decimales');
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);

/** Límites del plan; `null` = sin límite. */
export const PlanLimitsSchema = z
  .object({
    branches: z.number().int().nonnegative().nullable().default(null),
    vehicles: z.number().int().nonnegative().nullable().default(null),
    storageGb: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

/** Política de estados del plan (multitenancy §5.4): días de gracia en PAST_DUE y de cierre en CANCELLED. */
export const SuspensionPolicySchema = z
  .object({
    pastDueGraceDays: z.number().int().min(0).max(60).default(7),
    cancelledClosingDays: z.number().int().min(0).max(180).default(30),
  })
  .strict();
export type SuspensionPolicy = z.infer<typeof SuspensionPolicySchema>;

export const PlatformModuleSchema = z.object({ code: z.string(), name: z.string(), description: z.string() });
export const PlatformModulesResponseSchema = z.object({ modules: z.array(PlatformModuleSchema) });
export type PlatformModulesResponse = z.infer<typeof PlatformModulesResponseSchema>;

export const PlanVersionInputSchema = z
  .object({
    currency: CurrencySchema.default('PEN'),
    basePrice: MoneySchema,
    billingInterval: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']),
    includedUsers: z.number().int().nonnegative(),
    extraUserPrice: MoneySchema,
    usageMetric: z.enum(['PEAK_DAILY', 'AVERAGE_DAILY', 'END_OF_PERIOD']).default('PEAK_DAILY'),
    dailyAggregation: z.enum(['PEAK_CONCURRENT', 'DISTINCT_ACTIVE']).default('PEAK_CONCURRENT'),
    minActiveSeconds: z.number().int().nonnegative().default(0),
    trialDays: z.number().int().min(0).max(365).default(0),
    limits: PlanLimitsSchema.default({ branches: null, vehicles: null, storageGb: null }),
    suspensionPolicy: SuspensionPolicySchema.default({ pastDueGraceDays: 7, cancelledClosingDays: 30 }),
    modules: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]+$/))
      .max(50)
      .refine((m) => new Set(m).size === m.length, { message: 'Módulos repetidos' }),
  })
  .strict();
export type PlanVersionInput = z.infer<typeof PlanVersionInputSchema>;

export const PlanVersionSchema = PlanVersionInputSchema.extend({
  id: z.string(),
  version: z.number().int(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']),
  publishedAt: z.iso.datetime().nullable(),
  retiredAt: z.iso.datetime().nullable(),
});
export type PlanVersion = z.infer<typeof PlanVersionSchema>;

export const PlanSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']),
  versions: z.array(PlanVersionSchema),
});
export type Plan = z.infer<typeof PlanSchema>;
export const PlansResponseSchema = z.object({ plans: z.array(PlanSchema) });
export type PlansResponse = z.infer<typeof PlansResponseSchema>;

export const CreatePlanRequestSchema = z
  .object({
    code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,49}$/),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).default(''),
  })
  .strict();
export type CreatePlanRequest = z.infer<typeof CreatePlanRequestSchema>;

export const ModuleOverrideInputSchema = z
  .object({
    moduleCode: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    effect: z.enum(['GRANT', 'REVOKE']),
    validFrom: z.iso.datetime().optional(),
    validTo: z.iso.datetime().nullable().optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type ModuleOverrideInput = z.infer<typeof ModuleOverrideInputSchema>;

export const ModuleOverrideSchema = z.object({
  id: z.string(),
  moduleCode: z.string(),
  effect: z.enum(['GRANT', 'REVOKE']),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
  reason: z.string(),
  endedAt: z.iso.datetime().nullable(),
});
export type ModuleOverride = z.infer<typeof ModuleOverrideSchema>;
export const ModuleOverridesResponseSchema = z.object({ overrides: z.array(ModuleOverrideSchema) });
export type ModuleOverridesResponse = z.infer<typeof ModuleOverridesResponseSchema>;
