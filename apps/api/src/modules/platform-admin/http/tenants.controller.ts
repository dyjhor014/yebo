import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ChangeTenantStatusRequestSchema,
  CreateTenantRequestSchema,
  OperationOverrideInputSchema,
  TenantUsageQuerySchema,
  type CreateTenantResponse,
  type PlatformTenantRolesResponse,
  type TenantUsageResponse,
  type OperationOverride,
  type OperationOverridesResponse,
  type TenantDetail,
  type TenantsResponse,
} from '@yebo/contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { createZodDto } from 'nestjs-zod';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { AppError } from '../../../common/errors/app-error';
import { PlatformProtected } from '../../access/route-policy';
import { TenantsService } from '../tenants.service';
import { meta, noStore } from './platform-auth.controller';

class CreateTenantRequestDto extends createZodDto(CreateTenantRequestSchema) {}
class ChangeTenantStatusRequestDto extends createZodDto(ChangeTenantStatusRequestSchema) {}
class OperationOverrideInputDto extends createZodDto(OperationOverrideInputSchema) {}

/** Empresas en el panel de YEBO (Fase 4.3a): alta, ficha, estados y excepciones de operación. */
@ApiTags('platform')
@Controller({ path: 'platform/tenants', version: '1' })
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  @Get()
  @PlatformProtected('platform.tenants.read')
  async list(@Res({ passthrough: true }) res: Response): Promise<TenantsResponse> {
    noStore(res);
    return { tenants: await this.tenants.list() };
  }

  @Post()
  @PlatformProtected('platform.tenants.manage')
  create(
    @Body() body: CreateTenantRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CreateTenantResponse> {
    noStore(res); // puede llevar el enlace de invitación, que se muestra una sola vez
    return this.tenants.create(this.actor(), body, meta(req));
  }

  @Get(':tenantId/usage')
  @PlatformProtected('platform.billing.read')
  async usage(
    @Param('tenantId') tenantId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TenantUsageResponse> {
    noStore(res);
    const parsed = TenantUsageQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Indica from y to (AAAA-MM-DD)', 400);
    return this.tenants.usage(tenantId, parsed.data.from, parsed.data.to);
  }

  @Get(':tenantId/roles')
  @PlatformProtected('platform.tenants.read')
  async roles(@Param('tenantId') tenantId: string): Promise<PlatformTenantRolesResponse> {
    return { roles: await this.tenants.listRoles(tenantId) };
  }

  @Get(':tenantId')
  @PlatformProtected('platform.tenants.read')
  get(@Param('tenantId') tenantId: string, @Res({ passthrough: true }) res: Response): Promise<TenantDetail> {
    noStore(res);
    return this.tenants.get(tenantId);
  }

  @Post(':tenantId/status')
  @PlatformProtected('platform.tenants.manage')
  @HttpCode(200)
  changeStatus(
    @Param('tenantId') tenantId: string,
    @Body() body: ChangeTenantStatusRequestDto,
    @Req() req: Request,
  ): Promise<TenantDetail> {
    return this.tenants.changeStatus(this.actor(), tenantId, body, meta(req));
  }

  @Get(':tenantId/operation-overrides')
  @PlatformProtected('platform.tenants.read')
  async overrides(@Param('tenantId') tenantId: string): Promise<OperationOverridesResponse> {
    return { overrides: await this.tenants.listOperationOverrides(tenantId) };
  }

  @Post(':tenantId/operation-overrides')
  @PlatformProtected('platform.tenants.manage')
  createOverride(
    @Param('tenantId') tenantId: string,
    @Body() body: OperationOverrideInputDto,
    @Req() req: Request,
  ): Promise<OperationOverride> {
    return this.tenants.createOperationOverride(this.actor(), tenantId, body, meta(req));
  }

  @Post(':tenantId/operation-overrides/:overrideId/end')
  @PlatformProtected('platform.tenants.manage')
  @HttpCode(204)
  async endOverride(
    @Param('tenantId') tenantId: string,
    @Param('overrideId') overrideId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.tenants.endOperationOverride(this.actor(), tenantId, overrideId, meta(req));
  }

  private actor() {
    const principal = this.cls.get('platformPrincipal');
    if (!principal) throw new Error('PlatformGuard no fijó la sesión del staff');
    return principal;
  }
}
