import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PlatformInvitationRequestSchema, type PlatformInvitationResponse } from '@yebo/contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../../common/errors/app-error';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { PlatformAuthenticated } from '../../access/route-policy';
import type { PlatformPermission } from '../platform-permissions';
import { StaffService } from '../staff.service';
import { TenantsService } from '../tenants.service';
import { meta, noStore } from './platform-auth.controller';

/** Permiso que exige cada destino: los dos realms conservan sus propios permisos. */
const PERMISSION_FOR: Record<'STAFF' | 'TENANT', PlatformPermission> = {
  STAFF: 'platform.staff.manage',
  TENANT: 'platform.tenants.manage',
};

/**
 * «Invitar usuario» del panel (decisión del responsable, 2026-11-10): una sola acción en la que se elige el destino,
 * el staff de YEBO o una empresa. La ruta exige la sesión del staff y el permiso se comprueba según el destino.
 */
@ApiTags('platform')
@Controller({ path: 'platform/invitations', version: '1' })
export class PlatformInvitationsController {
  constructor(
    private readonly staff: StaffService,
    private readonly tenants: TenantsService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  @Post()
  @PlatformAuthenticated()
  async invite(
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlatformInvitationResponse> {
    noStore(res); // el enlace se muestra una sola vez
    // Unión discriminada por `target`: se valida aquí (createZodDto no admite uniones).
    const parsed = PlatformInvitationRequestSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Revisa los datos de la invitación', 400);
    const body = parsed.data;
    const actor = this.cls.get('platformPrincipal');
    if (!actor) throw new Error('PlatformGuard no fijó la sesión del staff');
    if (!actor.permissions.has(PERMISSION_FOR[body.target])) {
      throw new AppError('FORBIDDEN', 'No tienes permiso para esta operación', 403);
    }
    if (body.target === 'STAFF') {
      const created = await this.staff.create(
        actor,
        { email: body.email, fullName: body.fullName, role: body.role },
        meta(req),
      );
      return {
        target: 'STAFF',
        id: created.platformUserId,
        email: body.email,
        expiresAt: created.setupExpiresAt,
        link: created.setupUrl,
      };
    }
    const link = await this.tenants.inviteToTenant(actor, body.tenantId, body.email, body.roleIds, meta(req));
    return { target: 'TENANT', id: link.id, email: link.email, expiresAt: link.expiresAt, link: link.link };
  }
}
