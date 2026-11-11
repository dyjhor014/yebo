import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ObligationsResponse } from '@yebo/contracts';
import type { Response } from 'express';
import { Prisma } from '../../../generated/prisma/client';
import { TenantDbService } from '../../../infrastructure/database/tenant-db.service';
import { Protected } from '../../access/route-policy';
import { readInvoices } from '../billing-view';

/**
 * «Obligaciones con YEBO» de la empresa del host (Fase 4.5; categoría BILLING_SELF, disponible también en
 * SUSPENDED o EXPIRED para poder regularizar). Con `yebo_app` y RLS: cada empresa ve solo lo suyo.
 */
@ApiTags('billing')
@Controller({ path: 'billing', version: '1' })
export class ObligationsController {
  constructor(private readonly db: TenantDbService) {}

  @Get('obligations')
  @Protected('billing.read', 'BILLING_SELF')
  async obligations(@Res({ passthrough: true }) res: Response): Promise<ObligationsResponse> {
    res.setHeader('Cache-Control', 'no-store');
    return this.db.transaction(async (tx) => {
      const invoices = await readInvoices(tx as unknown as Prisma.TransactionClient);
      const outstanding = new Map<string, Prisma.Decimal>();
      for (const i of invoices) {
        if (!['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(i.status)) continue;
        outstanding.set(i.currency, (outstanding.get(i.currency) ?? new Prisma.Decimal(0)).add(i.balance));
      }
      const current = await tx.billingPeriod.findFirst({
        where: { status: 'OPEN' },
        orderBy: { periodStart: 'desc' },
        select: { periodStart: true, periodEnd: true, isTrial: true },
      });
      return {
        outstanding: [...outstanding].map(([currency, amount]) => ({ currency, amount: amount.toFixed(2) })),
        currentPeriod: current
          ? {
              periodStart: current.periodStart.toISOString().slice(0, 10),
              periodEnd: current.periodEnd.toISOString().slice(0, 10),
              isTrial: current.isTrial,
            }
          : null,
        invoices,
      };
    });
  }
}
