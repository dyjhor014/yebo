import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreatePlatformStaffRequestSchema,
  type CreatePlatformStaffResponse,
  type DisablePlatformStaffResponse,
  type PlatformSetupLinkResponse,
  type PlatformStaffListResponse,
} from '@yebo/contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { createZodDto } from 'nestjs-zod';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { PlatformProtected } from '../../access/route-policy';
import { StaffService } from '../staff.service';
import { meta, noStore } from './platform-auth.controller';

class CreatePlatformStaffRequestDto extends createZodDto(CreatePlatformStaffRequestSchema) {}

/** Gestión del staff de YEBO (solo SUPERADMIN: `platform.staff.manage`). */
@ApiTags('platform')
@Controller({ path: 'platform/staff', version: '1' })
@PlatformProtected('platform.staff.manage')
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  @Get()
  async list(@Res({ passthrough: true }) res: Response): Promise<PlatformStaffListResponse> {
    noStore(res);
    return { staff: await this.staff.list() };
  }

  /** Alta con enlace de configuración de un solo uso, que se muestra UNA vez a quien la hace (F4-Q3). */
  @Post()
  async create(
    @Body() body: CreatePlatformStaffRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CreatePlatformStaffResponse> {
    noStore(res);
    return this.staff.create(this.actor(), body, meta(req));
  }

  @Post(':platformUserId/setup-link')
  @HttpCode(200)
  async setupLink(
    @Param('platformUserId') platformUserId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlatformSetupLinkResponse> {
    noStore(res);
    return this.staff.reissueSetupLink(this.actor(), platformUserId, meta(req));
  }

  @Post(':platformUserId/disable')
  @HttpCode(200)
  async disable(
    @Param('platformUserId') platformUserId: string,
    @Req() req: Request,
  ): Promise<DisablePlatformStaffResponse> {
    return { revokedSessions: await this.staff.disable(this.actor(), platformUserId, meta(req)) };
  }

  private actor() {
    const principal = this.cls.get('platformPrincipal');
    if (!principal) throw new Error('PlatformGuard no fijó la sesión del staff');
    return principal;
  }
}
