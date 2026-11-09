import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ChangePlanRequestSchema,
  RecordPaymentRequestSchema,
  type ChangePlanResponse,
  type Invoice,
  type TenantBillingResponse,
} from '@yebo/contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { createZodDto } from 'nestjs-zod';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { PlatformProtected } from '../../access/route-policy';
import { BillingService } from '../billing.service';
import { PlanChangeService } from '../plan-change.service';
import { meta, noStore } from './platform-auth.controller';

class RecordPaymentRequestDto extends createZodDto(RecordPaymentRequestSchema) {}
class ChangePlanRequestDto extends createZodDto(ChangePlanRequestSchema) {}

/** Facturación de las empresas en el panel (Fase 4.5). */
@ApiTags('platform')
@Controller({ path: 'platform/tenants/:tenantId', version: '1' })
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly plans: PlanChangeService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  @Get('billing')
  @PlatformProtected('platform.billing.read')
  billingOf(
    @Param('tenantId') tenantId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TenantBillingResponse> {
    noStore(res);
    return this.billing.tenantBilling(tenantId);
  }

  /** Pago registrado a mano (BILLING o SUPERADMIN). */
  @Post('invoices/:invoiceId/payments')
  @PlatformProtected('platform.billing.manage')
  recordPayment(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() body: RecordPaymentRequestDto,
    @Req() req: Request,
  ): Promise<{ invoice: Invoice; tenantStatus: string }> {
    const actor = this.cls.get('platformPrincipal');
    if (!actor) throw new Error('PlatformGuard no fijó la sesión del staff');
    return this.billing.recordPayment(actor, tenantId, invoiceId, body, meta(req));
  }

  /** Cambio de plan: upgrade desde hoy (prorrateo del período en curso), downgrade desde el período siguiente. */
  @Post('subscription/plan')
  @PlatformProtected('platform.billing.manage')
  changePlan(
    @Param('tenantId') tenantId: string,
    @Body() body: ChangePlanRequestDto,
    @Req() req: Request,
  ): Promise<ChangePlanResponse> {
    const actor = this.cls.get('platformPrincipal');
    if (!actor) throw new Error('PlatformGuard no fijó la sesión del staff');
    return this.plans.change(actor, tenantId, body, meta(req));
  }
}
