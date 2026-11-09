import { z } from 'zod';

/**
 * Empresas (tenants) en el panel de YEBO (Fase 4.3a): alta, ficha, máquina de estados y excepciones de operación.
 * La lista de subdominios reservados (MKT-D6) se valida en el servidor, que conoce los hosts de la plataforma.
 */
export const TenantStatusSchema = z.enum([
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELLED',
  'EXPIRED',
]);
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

/** Etiqueta DNS en minúsculas, 3–40 caracteres, sin guiones al principio, al final ni dobles (ni `xn--`). */
export const TenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Solo letras, números y guiones simples');

export const ServiceModalitySchema = z.enum(['LAND', 'RIVER']);
export const TransportServiceSchema = z.enum(['PASSENGER', 'PARCEL', 'CARGO', 'VEHICLE_TRANSPORT']);
export const TenantServiceInputSchema = z
  .object({ modality: ServiceModalitySchema, service: TransportServiceSchema })
  .strict();
export type TenantServiceInput = z.infer<typeof TenantServiceInputSchema>;

export const CreateTenantRequestSchema = z
  .object({
    slug: TenantSlugSchema,
    legalName: z.string().trim().min(1).max(200),
    tradeName: z.string().trim().min(1).max(120),
    taxIdType: z.enum(['RUC', 'DNI', 'CE', 'PASSPORT']).default('RUC'),
    taxId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{4,20}$/),
    timezone: z
      .string()
      .default('America/Lima')
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Zona horaria IANA inválida'),
    /** Versión de plan PUBLICADA con la que nace la suscripción. */
    planVersionId: z.uuid(),
    services: z
      .array(TenantServiceInputSchema)
      .min(1)
      .max(8)
      .refine((s) => new Set(s.map((x) => `${x.modality}:${x.service}`)).size === s.length, {
        message: 'Servicios repetidos',
      }),
    /** Primer administrador: se le invita con el rol Administrador y el enlace se devuelve una vez (F4-Q3). */
    firstAdminEmail: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
  })
  .strict();
export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;

export const TenantSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  tradeName: z.string(),
  legalName: z.string(),
  status: TenantStatusSchema,
  primaryHost: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type TenantSummary = z.infer<typeof TenantSummarySchema>;
/**
 * Fila de la lista de empresas del panel (Fase 4.7): lo necesario para decidir a quién atender primero.
 * `milestone` es el próximo hito del trayecto del tenant (suspensión, fin de la prueba, fin del período...).
 */
export const TenantOverviewSchema = TenantSummarySchema.extend({
  modalities: z.array(z.enum(['LAND', 'RIVER'])),
  services: z.array(z.enum(['PASSENGER', 'PARCEL', 'CARGO', 'VEHICLE_TRANSPORT'])),
  plan: z.object({ name: z.string(), version: z.number().int() }).nullable(),
  /** Pico de usuarios facturables en los días cerrados del período en curso (null sin días cerrados). */
  usersPeak: z.number().int().nullable(),
  includedUsers: z.number().int().nullable(),
  /** Saldo pendiente de facturas emitidas, parciales o vencidas. */
  outstanding: z.string(),
  overdue: z.boolean(),
  currency: z.string(),
  milestone: z
    .object({
      kind: z.enum([
        'SUSPENDED_SINCE',
        'SUSPENDS_ON',
        'TRIAL_ENDS',
        'EXPIRED_SINCE',
        'CLOSING_ENDS',
        'PERIOD_ENDS',
      ]),
      date: z.iso.date(),
    })
    .nullable(),
});
export type TenantOverview = z.infer<typeof TenantOverviewSchema>;
export const TenantsResponseSchema = z.object({ tenants: z.array(TenantOverviewSchema) });
export type TenantsResponse = z.infer<typeof TenantsResponseSchema>;

export const TenantStatusChangeSchema = z.object({
  fromStatus: TenantStatusSchema.nullable(),
  toStatus: TenantStatusSchema,
  reason: z.string(),
  /** `null` = transición automática del job de estados. */
  actorPlatformUserId: z.string().nullable(),
  occurredAt: z.iso.datetime(),
});

export const TenantDetailSchema = TenantSummarySchema.extend({
  taxIdType: z.string(),
  taxId: z.string(),
  timezone: z.string(),
  trialEndsAt: z.iso.datetime().nullable(),
  activatedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  statusChangedAt: z.iso.datetime(),
  domains: z.array(
    z.object({
      host: z.string(),
      kind: z.enum(['SUBDOMAIN', 'CUSTOM']),
      isPrimary: z.boolean(),
      verificationStatus: z.enum(['PENDING', 'VERIFIED', 'FAILED']),
    }),
  ),
  services: z.array(TenantServiceInputSchema.extend({ enabled: z.boolean() })),
  subscription: z
    .object({
      id: z.string(),
      planVersionId: z.string(),
      status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED']),
      currentPeriodStart: z.iso.date(),
      currentPeriodEnd: z.iso.date(),
    })
    .nullable(),
  statusHistory: z.array(TenantStatusChangeSchema),
});
export type TenantDetail = z.infer<typeof TenantDetailSchema>;

export const ChangeTenantStatusRequestSchema = z
  .object({ to: TenantStatusSchema, reason: z.string().trim().min(3).max(500) })
  .strict();
export type ChangeTenantStatusRequest = z.infer<typeof ChangeTenantStatusRequestSchema>;

export const OperationOverrideInputSchema = z
  .object({
    category: z.enum(['USERS_ADD']),
    validFrom: z.iso.datetime().optional(),
    /** Obligatorio: la excepción es temporal (como mucho 30 días). */
    validTo: z.iso.datetime(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type OperationOverrideInput = z.infer<typeof OperationOverrideInputSchema>;

export const OperationOverrideSchema = z.object({
  id: z.string(),
  category: z.enum(['USERS_ADD']),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime(),
  reason: z.string(),
  endedAt: z.iso.datetime().nullable(),
});
export type OperationOverride = z.infer<typeof OperationOverrideSchema>;
export const OperationOverridesResponseSchema = z.object({ overrides: z.array(OperationOverrideSchema) });
export type OperationOverridesResponse = z.infer<typeof OperationOverridesResponseSchema>;

export const CreateTenantResponseSchema = TenantDetailSchema.extend({
  firstAdminInvitation: z
    .object({ id: z.string(), email: z.string(), expiresAt: z.iso.datetime(), link: z.string() })
    .nullable(),
});
export type CreateTenantResponse = z.infer<typeof CreateTenantResponseSchema>;

/** Consumo diario de una empresa (Fase 4.4; billing §3–4): días cerrados (FINAL) y el día en curso (PROVISIONAL). */
export const TenantUsageQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((q) => q.from <= q.to, { message: 'from debe ser anterior o igual a to' });
export type TenantUsageQuery = z.infer<typeof TenantUsageQuerySchema>;

export const TenantUsageResponseSchema = z.object({
  timezone: z.string(),
  days: z.array(
    z.object({
      date: z.iso.date(),
      peakConcurrent: z.number().int(),
      distinctActive: z.number().int(),
      status: z.enum(['PROVISIONAL', 'FINAL']),
    }),
  ),
});
export type TenantUsageResponse = z.infer<typeof TenantUsageResponseSchema>;
