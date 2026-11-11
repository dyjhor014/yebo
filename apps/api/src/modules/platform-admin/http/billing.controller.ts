import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ChangePlanRequestSchema,
  RecordPaymentRequestSchema,
  ReversePaymentRequestSchema,
  type ChangePlanResponse,
  type RecordPaymentResponse,
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
class ReversePaymentRequestDto extends createZodDto(ReversePaymentRequestSchema) {}
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
  ): Promise<RecordPaymentResponse> {
    const actor = this.cls.get('platformPrincipal');
    if (!actor) throw new Error('PlatformGuard no fijó la sesión del staff');
    return this.billing.recordPayment(actor, tenantId, invoiceId, body, meta(req));
  }

  /** Anular un pago (BILLING o SUPERADMIN), con motivo; repone el saldo de la factura. */
  @Post('payments/:paymentId/reverse')
  @PlatformProtected('platform.billing.manage')
  @HttpCode(200)
  reversePayment(
    @Param('tenantId') tenantId: string,
    @Param('paymentId') paymentId: string,
    @Body() body: ReversePaymentRequestDto,
    @Req() req: Request,
  ): Promise<RecordPaymentResponse> {
    const actor = this.cls.get('platformPrincipal');
    if (!actor) throw new Error('PlatformGuard no fijó la sesión del staff');
    return this.billing.reversePayment(actor, tenantId, paymentId, body, meta(req));
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
