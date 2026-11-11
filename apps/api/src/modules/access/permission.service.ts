import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { PERMISSION_CODES } from './permission-catalog';

/**
 * Permisos efectivos de una membresía: unión de los permisos de sus roles no archivados (security.md §2).
 * Se leen con `yebo_app` dentro del tenant del contexto (RLS + filtro de aplicación): roles, role_permissions y
 * membership_roles son datos del tenant; el catálogo `permissions` es de solo lectura para este rol.
 *
 * Sin caché entre requests: la versión de permisos se verifica en PostgreSQL en cada request, y la lectura de los
 * permisos es una consulta indexada por membresía. El coste se mide en la etapa 3.4.
 */
@Injectable()
export class PermissionService {
  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  /** Permisos de la membresía autenticada en este request (se cargan una sola vez por request). */
  async current(): Promise<ReadonlySet<string>> {
    const cached = this.cls.get('permissions');
    if (cached) return cached;
    // Soporte del staff (Fase 4.6): todos los permisos de empresa; el alcance READ_ONLY lo limita el guard por
    // categoría, y las rutas de gestión del propio acceso de soporte lo rechazan.
    if (this.cls.get('supportPrincipal')) {
      const all: ReadonlySet<string> = new Set(PERMISSION_CODES);
      this.cls.set('permissions', all);
      return all;
    }
    const principal = this.cls.get('principal');
    if (!principal) throw new Error('PermissionService.current() requiere una sesión verificada');
    const permissions = await this.forMembership(principal.membershipId);
    this.cls.set('permissions', permissions);
    return permissions;
  }

  /** Permisos de una membresía del tenant del contexto (vacío si no existe en este tenant). */
  async forMembership(membershipId: string): Promise<ReadonlySet<string>> {
    const rows = await this.db.client.membershipRole.findMany({
      where: { membershipId, role: { archivedAt: null } },
      select: { role: { select: { permissions: { select: { permission: { select: { code: true } } } } } } },
    });
    return new Set(rows.flatMap((r) => r.role.permissions.map((p) => p.permission.code)));
  }
}
