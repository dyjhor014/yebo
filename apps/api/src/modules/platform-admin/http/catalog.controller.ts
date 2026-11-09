import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreatePlanRequestSchema,
  ModuleOverrideInputSchema,
  PlanVersionInputSchema,
  type ModuleOverride,
  type ModuleOverridesResponse,
  type Plan,
  type PlanVersion,
  type PlansResponse,
  type PlatformModulesResponse,
} from '@yebo/contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { createZodDto } from 'nestjs-zod';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { PlatformProtected } from '../../access/route-policy';
import { CatalogService } from '../catalog.service';
import { meta, noStore } from './platform-auth.controller';

class CreatePlanRequestDto extends createZodDto(CreatePlanRequestSchema) {}
class PlanVersionInputDto extends createZodDto(PlanVersionInputSchema) {}
class ModuleOverrideInputDto extends createZodDto(ModuleOverrideInputSchema) {}

/** Catálogo comercial del superadmin (Fase 4.2). */
@ApiTags('platform')
@Controller({ path: 'platform', version: '1' })
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  @Get('modules')
  @PlatformProtected('platform.billing.read')
  async modules(@Res({ passthrough: true }) res: Response): Promise<PlatformModulesResponse> {
    noStore(res);
    return { modules: await this.catalog.listModules() };
  }

  @Get('plans')
  @PlatformProtected('platform.billing.read')
  async plans(@Res({ passthrough: true }) res: Response): Promise<PlansResponse> {
    noStore(res);
    return { plans: await this.catalog.listPlans() };
  }

  @Post('plans')
  @PlatformProtected('platform.plans.manage')
  createPlan(@Body() body: CreatePlanRequestDto, @Req() req: Request): Promise<Plan> {
    return this.catalog.createPlan(this.actor(), body, meta(req));
  }

  @Post('plans/:planId/versions')
  @PlatformProtected('platform.plans.manage')
  createVersion(
    @Param('planId') planId: string,
    @Body() body: PlanVersionInputDto,
    @Req() req: Request,
  ): Promise<PlanVersion> {
    return this.catalog.createVersion(this.actor(), planId, body, meta(req));
  }

  @Put('plan-versions/:versionId')
  @PlatformProtected('platform.plans.manage')
  updateDraft(
    @Param('versionId') versionId: string,
    @Body() body: PlanVersionInputDto,
    @Req() req: Request,
  ): Promise<PlanVersion> {
    return this.catalog.updateDraft(this.actor(), versionId, body, meta(req));
  }

  @Post('plan-versions/:versionId/publish')
  @PlatformProtected('platform.plans.manage')
  @HttpCode(200)
  publish(@Param('versionId') versionId: string, @Req() req: Request): Promise<PlanVersion> {
    return this.catalog.publish(this.actor(), versionId, meta(req));
  }

  @Post('plan-versions/:versionId/retire')
  @PlatformProtected('platform.plans.manage')
  @HttpCode(200)
  retire(@Param('versionId') versionId: string, @Req() req: Request): Promise<PlanVersion> {
    return this.catalog.retire(this.actor(), versionId, meta(req));
  }

  @Get('tenants/:tenantId/module-overrides')
  @PlatformProtected('platform.tenants.read')
  async overrides(@Param('tenantId') tenantId: string): Promise<ModuleOverridesResponse> {
    return { overrides: await this.catalog.listOverrides(tenantId) };
  }

  @Post('tenants/:tenantId/module-overrides')
  @PlatformProtected('platform.tenants.manage')
  createOverride(
    @Param('tenantId') tenantId: string,
    @Body() body: ModuleOverrideInputDto,
    @Req() req: Request,
  ): Promise<ModuleOverride> {
    return this.catalog.createOverride(this.actor(), tenantId, body, meta(req));
  }

  @Post('tenants/:tenantId/module-overrides/:overrideId/end')
  @PlatformProtected('platform.tenants.manage')
  @HttpCode(204)
  async endOverride(
    @Param('tenantId') tenantId: string,
    @Param('overrideId') overrideId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.catalog.endOverride(this.actor(), tenantId, overrideId, meta(req));
  }

  private actor() {
    const principal = this.cls.get('platformPrincipal');
    if (!principal) throw new Error('PlatformGuard no fijó la sesión del staff');
    return principal;
  }
}
