import { Body, Controller, Get, HttpCode, Param, Post, Put, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SupportSettingsSchema, type SupportGrantsResponse, type SupportSettings } from '@yebo/contracts';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error';
import type { Prisma } from '../../../generated/prisma/client';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { TenantDbService } from '../../../infrastructure/database/tenant-db.service';
import { Clock } from '../../identity/clock';
import { Protected } from '../../access/route-policy';
import { readSupportGrants } from '../grant-view';

class SupportSettingsDto extends createZodDto(SupportSettingsSchema) {}
const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);

/**
 * Accesos de soporte de YEBO vistos por la empresa (Fase 4.6): quién, por qué, con qué alcance, hasta cuándo y cada
 * petición que hizo. La empresa puede aprobarlos (si exige aprobación), revocarlos y decidir si exige aprobación.
 * Estas rutas son de la EMPRESA: una sesión de soporte no puede gestionar su propio acceso. Categoría
 * CONFIGURE_COMPLIANCE: disponibles también con la empresa suspendida, cuando más se necesita soporte.
 */
@ApiTags('support')
@Controller({ path: 'support-access', version: '1' })
export class SupportAccessController {
  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly clock: Clock,
  ) {}

  @Get()
  @Protected('support.read', 'READ')
  async list(@Res({ passthrough: true }) res: Response): Promise<SupportGrantsResponse> {
    res.setHeader('Cache-Control', 'no-store');
    return this.db.transaction(async (tx) => ({
      grants: await readSupportGrants(tx as unknown as Prisma.TransactionClient, this.clock.now()),
    }));
  }

  @Post(':grantId/approve')
  @Protected('support.manage', 'CONFIGURE_COMPLIANCE')
  @HttpCode(204)
  async approve(@Param('grantId') grantId: string): Promise<void> {
    const membershipId = this.member();
    if (!UUID.safeParse(grantId).success) throw NOT_FOUND();
    const now = this.clock.now();
    const done = await this.db.client.supportAccessGrant.updateMany({
      where: {
        id: grantId,
        requiresApproval: true,
        approvedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { approvedAt: now, approvedByMembershipId: membershipId },
    });
    if (done.count !== 1) throw NOT_FOUND();
  }

  @Post(':grantId/revoke')
  @Protected('support.manage', 'CONFIGURE_COMPLIANCE')
  @HttpCode(204)
  async revoke(@Param('grantId') grantId: string): Promise<void> {
    const membershipId = this.member();
    if (!UUID.safeParse(grantId).success) throw NOT_FOUND();
    const done = await this.db.client.supportAccessGrant.updateMany({
      where: { id: grantId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedByKind: 'MEMBERSHIP', revokedById: membershipId },
    });
    if (done.count !== 1) throw NOT_FOUND();
  }

  @Put('settings')
  @Protected('support.manage', 'CONFIGURE_COMPLIANCE')
  async settings(@Body() body: SupportSettingsDto): Promise<SupportSettings> {
    this.member();
    const tenantId = this.cls.get('tenantId') as string;
    await this.db.client.tenantSetting.updateMany({
      where: { tenantId },
      data: { supportRequiresApproval: body.requiresApproval },
    });
    return { requiresApproval: body.requiresApproval };
  }

  /** Solo una persona de la empresa: el staff de soporte no gestiona su propio acceso. */
  private member(): string {
    if (this.cls.get('supportPrincipal')) {
      throw new AppError('FORBIDDEN', 'Una sesión de soporte no puede gestionar los accesos de soporte', 403);
    }
    const principal = this.cls.get('principal');
    if (!principal) throw new Error('AuthenticationGuard no fijó la sesión');
    return principal.membershipId;
  }
}
