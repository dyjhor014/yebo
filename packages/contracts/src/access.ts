import { z } from 'zod';

/**
 * Gestión de accesos de la empresa (Fase 3.3): miembros, roles y sesiones. El tenant sale SIEMPRE del host;
 * ningún contrato acepta un `tenantId`.
 */
export const MembershipStatusSchema = z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED']);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

export const MemberSchema = z.object({
  membershipId: z.string(),
  email: z.string(),
  fullName: z.string(),
  displayName: z.string().nullable(),
  status: MembershipStatusSchema,
  roleIds: z.array(z.string()),
});
export type Member = z.infer<typeof MemberSchema>;

export const MembersResponseSchema = z.object({ members: z.array(MemberSchema) });
export type MembersResponse = z.infer<typeof MembersResponseSchema>;

export const MemberStatusResponseSchema = z.object({
  membershipId: z.string(),
  status: MembershipStatusSchema,
  /** Sesiones de empresa cerradas como parte de la operación. */
  revokedSessions: z.number().int().nonnegative(),
});
export type MemberStatusResponse = z.infer<typeof MemberStatusResponseSchema>;

export const RevokeMemberSessionsResponseSchema = z.object({
  revokedSessions: z.number().int().nonnegative(),
});
export type RevokeMemberSessionsResponse = z.infer<typeof RevokeMemberSessionsResponseSchema>;

export const AssignRolesRequestSchema = z
  .object({
    roleIds: z
      .array(z.uuid())
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Roles repetidos' }),
  })
  .strict();
export type AssignRolesRequest = z.infer<typeof AssignRolesRequestSchema>;

export const AssignRolesResponseSchema = z.object({
  membershipId: z.string(),
  roleIds: z.array(z.string()),
});
export type AssignRolesResponse = z.infer<typeof AssignRolesResponseSchema>;

export const RoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
});
export type Role = z.infer<typeof RoleSchema>;

export const RolesResponseSchema = z.object({ roles: z.array(RoleSchema) });
export type RolesResponse = z.infer<typeof RolesResponseSchema>;
