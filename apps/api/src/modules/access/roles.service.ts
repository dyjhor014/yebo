import { Injectable } from '@nestjs/common';
import type { Role } from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { ROLE_TEMPLATES } from './permission-catalog';

/** Roles de la empresa del host (configuración del tenant; RLS + filtro de aplicación). */
@Injectable()
export class RolesService {
  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  async list(): Promise<Role[]> {
    const rows = await this.db.client.role.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        name: true,
        isSystem: true,
        permissions: { select: { permission: { select: { code: true } } } },
      },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      isSystem: r.isSystem,
      permissions: r.permissions.map((p) => p.permission.code).sort(),
    }));
  }

  /**
   * Crea en el tenant del contexto los roles de sistema a partir de las plantillas de la plataforma
   * (`role_templates`, security.md §2). Idempotente por nombre. Lo usará el alta de empresas (Fase 4).
   * Lee la plantilla de la BASE (no de este archivo): la base es lo que se sembró por migración.
   */
  async instantiateTemplates(codes: readonly (keyof typeof ROLE_TEMPLATES)[] = ['ADMIN']): Promise<string[]> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new Error('instantiateTemplates requiere el tenant del contexto');
    return this.db.transaction(async (tx) => {
      const created: string[] = [];
      const templates = await tx.roleTemplate.findMany({ where: { code: { in: [...codes] } } });
      for (const template of templates) {
        const existing = await tx.role.findFirst({ where: { name: template.name }, select: { id: true } });
        if (existing) continue;
        const permissions = await tx.permission.findMany({
          where: { code: { in: template.permissionCodes } },
          select: { id: true },
        });
        const role = await tx.role.create({
          data: { tenantId, name: template.name, templateId: template.id, isSystem: true },
          select: { id: true },
        });
        await tx.rolePermission.createMany({
          data: permissions.map((p) => ({ tenantId, roleId: role.id, permissionId: p.id })),
        });
        created.push(role.id);
      }
      return created;
    });
  }
}
