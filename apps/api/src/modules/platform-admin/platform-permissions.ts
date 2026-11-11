import type { PlatformRole } from '../../generated/prisma/client';

/**
 * Permisos de PLATAFORMA (security.md §2: «permisos de plataforma separados»). Nunca se mezclan con los permisos de
 * empresa: un miembro del staff no tiene membresías y solo entra en datos de un tenant con un acceso de soporte
 * vigente (etapa 4.6). Fuente única en código: el rol de cada persona del staff define su conjunto.
 */
export const PLATFORM_PERMISSIONS = [
  'platform.staff.manage',
  'platform.tenants.read',
  'platform.tenants.manage',
  'platform.plans.manage',
  'platform.billing.read',
  'platform.billing.manage',
  'platform.support.access',
  'platform.audit.read',
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

const READ: PlatformPermission[] = ['platform.tenants.read', 'platform.billing.read'];

export const PLATFORM_ROLE_PERMISSIONS: Readonly<Record<PlatformRole, readonly PlatformPermission[]>> = {
  SUPERADMIN: PLATFORM_PERMISSIONS,
  BILLING: [...READ, 'platform.plans.manage', 'platform.billing.manage'],
  SUPPORT: [...READ, 'platform.support.access'],
  VIEWER: READ,
};
