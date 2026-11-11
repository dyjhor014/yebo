import { z } from 'zod';

/**
 * Invitaciones de membresía (Fase 4.3b; multitenancy §1.1; F4-Q3). La respuesta al invitar es la MISMA exista o no
 * una cuenta con ese correo. El enlace se muestra una sola vez a quien invita, que lo envía por su canal (hasta que
 * llegue el correo en la Fase 12).
 */
export const InvitationEmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const CreateInvitationRequestSchema = z
  .object({
    email: InvitationEmailSchema,
    roleIds: z
      .array(z.uuid())
      .min(1)
      .max(20)
      .refine((r) => new Set(r).size === r.length, { message: 'Roles repetidos' }),
  })
  .strict();
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;

export const InvitationLinkSchema = z.object({
  id: z.string(),
  email: z.string(),
  expiresAt: z.iso.datetime(),
  /** Se muestra UNA vez: en la base solo queda el hash del secreto. */
  link: z.string(),
});
export type InvitationLink = z.infer<typeof InvitationLinkSchema>;

export const InvitationStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']);
export const InvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  roleIds: z.array(z.string()),
  status: InvitationStatusSchema,
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type Invitation = z.infer<typeof InvitationSchema>;
export const InvitationsResponseSchema = z.object({ invitations: z.array(InvitationSchema) });
export type InvitationsResponse = z.infer<typeof InvitationsResponseSchema>;

/**
 * Panel del staff: «Invitar usuario» con el destino elegido (decisión del responsable, 2026-11-10).
 * - `STAFF`: alta de un miembro del staff de YEBO con su rol de plataforma y enlace de configuración (Fase 4.1).
 * - `TENANT`: invitación a una empresa con roles de esa empresa; se acepta en el hub (Fase 4.3b).
 * Los dos realms siguen separados: solo cambia el punto de entrada del panel.
 */
export const PlatformInvitationRequestSchema = z.discriminatedUnion('target', [
  z
    .object({
      target: z.literal('STAFF'),
      email: InvitationEmailSchema,
      fullName: z.string().trim().min(1).max(200),
      role: z.enum(['SUPERADMIN', 'BILLING', 'SUPPORT', 'VIEWER']),
    })
    .strict(),
  z
    .object({
      target: z.literal('TENANT'),
      tenantId: z.uuid(),
      email: InvitationEmailSchema,
      roleIds: z
        .array(z.uuid())
        .min(1)
        .max(20)
        .refine((r) => new Set(r).size === r.length, { message: 'Roles repetidos' }),
    })
    .strict(),
]);
export type PlatformInvitationRequest = z.infer<typeof PlatformInvitationRequestSchema>;

export const PlatformInvitationResponseSchema = z.object({
  target: z.enum(['STAFF', 'TENANT']),
  /** `STAFF`: id del miembro del staff creado; `TENANT`: id de la invitación. */
  id: z.string(),
  email: z.string(),
  expiresAt: z.iso.datetime(),
  /** Se muestra UNA vez (F4-Q3): enlace de configuración del staff o enlace de invitación del hub. */
  link: z.string(),
});
export type PlatformInvitationResponse = z.infer<typeof PlatformInvitationResponseSchema>;

/** Roles de una empresa, para elegir con cuáles se invita desde el panel. */
export const PlatformTenantRolesResponseSchema = z.object({
  roles: z.array(z.object({ id: z.string(), name: z.string(), isSystem: z.boolean() })),
});
export type PlatformTenantRolesResponse = z.infer<typeof PlatformTenantRolesResponseSchema>;

// Hub (`cuentas.<dominio>`): el token viaja en el cuerpo, nunca en la URL.
export const HubInvitationTokenSchema = z.object({ token: z.string().max(120) }).strict();
export type HubInvitationTokenRequest = z.infer<typeof HubInvitationTokenSchema>;

export const HubInvitationPreviewSchema = z.object({
  tradeName: z.string(),
  email: z.string(),
  expiresAt: z.iso.datetime(),
});
export type HubInvitationPreview = z.infer<typeof HubInvitationPreviewSchema>;

export const HubInvitationRegisterSchema = z
  .object({
    token: z.string().max(120),
    fullName: z.string().trim().min(2).max(120),
    password: z.string().min(1).max(1024),
  })
  .strict();
export type HubInvitationRegisterRequest = z.infer<typeof HubInvitationRegisterSchema>;

export const HubInvitationAcceptedSchema = z.object({ tradeName: z.string(), tenantHost: z.string() });
export type HubInvitationAccepted = z.infer<typeof HubInvitationAcceptedSchema>;
