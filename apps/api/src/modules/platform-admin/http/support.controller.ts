import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateSupportGrantRequestSchema,
  type SupportGrant,
  type SupportGrantsResponse,
  type SupportHandoffResponse,
} from '@yebo/contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { createZodDto } from 'nestjs-zod';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { PlatformProtected } from '../../access/route-policy';
import { SupportAccessService } from '../support-access.service';
import { meta, noStore } from './platform-auth.controller';

class CreateSupportGrantRequestDto extends createZodDto(CreateSupportGrantRequestSchema) {}

/** Accesos de soporte del staff a una empresa (Fase 4.6). Todo con `platform.support.access`. */
@ApiTags('platform')
@Controller({ path: 'platform/tenants/:tenantId/support-grants', version: '1' })
@PlatformProtected('platform.support.access')
export class SupportController {
  constructor(
    private readonly support: SupportAccessService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  @Get()
  async list(
    @Param('tenantId') tenantId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupportGrantsResponse> {
    noStore(res);
    return { grants: await this.support.list(tenantId) };
  }

  @Post()
  create(
    @Param('tenantId') tenantId: string,
    @Body() body: CreateSupportGrantRequestDto,
    @Req() req: Request,
  ): Promise<SupportGrant> {
    return this.support.create(this.actor(), tenantId, body, meta(req));
  }

  @Post(':grantId/revoke')
  @HttpCode(204)
  async revoke(
    @Param('tenantId') tenantId: string,
    @Param('grantId') grantId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.support.revoke(this.actor(), tenantId, grantId, meta(req));
  }

  /** Enlace de un solo uso (60 s) para abrir la sesión de soporte en el host de la empresa. */
  @Post(':grantId/handoff')
  @HttpCode(200)
  handoff(
    @Param('tenantId') tenantId: string,
    @Param('grantId') grantId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupportHandoffResponse> {
    noStore(res);
    return this.support.handoff(this.actor(), tenantId, grantId, meta(req));
  }

  private actor() {
    const principal = this.cls.get('platformPrincipal');
    if (!principal) throw new Error('PlatformGuard no fijó la sesión del staff');
    return principal;
  }
}
