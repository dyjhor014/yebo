import { z } from 'zod';

/**
 * API de plataforma (staff de YEBO, Fase 4.1). Realm separado de la identidad de clientes: host propio
 * (PLATFORM_ADMIN_HOST), sesión propia y permisos de plataforma.
 */
export const PlatformRoleSchema = z.enum(['SUPERADMIN', 'BILLING', 'SUPPORT', 'VIEWER']);
export type PlatformRole = z.infer<typeof PlatformRoleSchema>;

export const PlatformLoginRequestSchema = z
  .object({ email: z.email().max(254), password: z.string().min(1).max(1024) })
  .strict();
export type PlatformLoginRequest = z.infer<typeof PlatformLoginRequestSchema>;

/** Tras la contraseña siempre hay un segundo paso: verificar el código o activar la MFA. */
export const PlatformLoginResponseSchema = z.object({ next: z.enum(['MFA_VERIFY', 'MFA_ENROLL']) });
export type PlatformLoginResponse = z.infer<typeof PlatformLoginResponseSchema>;

export const PlatformMfaEnrollResponseSchema = z.object({
  /** Para el código QR de la app de autenticación. Se muestra una sola vez. */
  otpauthUri: z.string(),
  /** El mismo secreto en base32, para introducirlo a mano. */
  secret: z.string(),
});
export type PlatformMfaEnrollResponse = z.infer<typeof PlatformMfaEnrollResponseSchema>;

export const PlatformMfaCodeRequestSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export type PlatformMfaCodeRequest = z.infer<typeof PlatformMfaCodeRequestSchema>;

export const PlatformSessionResponseSchema = z.object({
  platformUserId: z.string(),
  email: z.string(),
  fullName: z.string(),
  role: PlatformRoleSchema,
  permissions: z.array(z.string()),
});
export type PlatformSessionResponse = z.infer<typeof PlatformSessionResponseSchema>;

export const PlatformSetupPasswordRequestSchema = z
  .object({ token: z.string().min(1).max(128), password: z.string().min(1).max(1024) })
  .strict();
export type PlatformSetupPasswordRequest = z.infer<typeof PlatformSetupPasswordRequestSchema>;

export const PlatformStaffMemberSchema = z.object({
  platformUserId: z.string(),
  email: z.string(),
  fullName: z.string(),
  role: PlatformRoleSchema,
  status: z.enum(['ACTIVE', 'DISABLED']),
  setupCompleted: z.boolean(),
  mfaEnabled: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
});
export type PlatformStaffMember = z.infer<typeof PlatformStaffMemberSchema>;

export const PlatformStaffListResponseSchema = z.object({ staff: z.array(PlatformStaffMemberSchema) });
export type PlatformStaffListResponse = z.infer<typeof PlatformStaffListResponseSchema>;

export const PlatformSetupLinkResponseSchema = z.object({
  /** Enlace de un solo uso. El token va en el fragmento (#): no llega al servidor ni al Referer. */
  setupUrl: z.string(),
  setupExpiresAt: z.iso.datetime(),
});
export type PlatformSetupLinkResponse = z.infer<typeof PlatformSetupLinkResponseSchema>;

export const DisablePlatformStaffResponseSchema = z.object({
  revokedSessions: z.number().int().nonnegative(),
});
export type DisablePlatformStaffResponse = z.infer<typeof DisablePlatformStaffResponseSchema>;
