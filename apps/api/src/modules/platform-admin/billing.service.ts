import { Injectable } from '@nestjs/common';
import type { Invoice, RecordPaymentRequest, TenantBillingResponse } from '@yebo/contracts';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { Prisma, type TenantStatus } from '../../generated/prisma/client';
import { readInvoices, readPeriods } from '../billing/billing-view';
import { Clock } from '../identity/clock';
import { BackofficePrismaService } from './backoffice-prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import { ipOf, type PlatformPrincipal, type RequestMeta } from './platform-auth.service';
import { TenantLifecycleService } from './tenant-lifecycle.service';

const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
/** Estados de la empresa de los que un pago la saca cuando ya no queda saldo vencido (multitenancy §5.2). */
const REACTIVABLE: readonly TenantStatus[] = ['PAST_DUE', 'SUSPENDED', 'EXPIRED'];

/**
 * Facturación de las empresas en el panel (Fase 4.5): consulta y pagos manuales (sin pagos simulados).
 * Registrar un pago, en UNA transacción con el contexto de la empresa: bloquea la factura, comprueba que el importe
 * no supere el saldo, guarda el pago, actualiza saldo y estado, y si ya no queda ninguna factura vencida con saldo,
 * reactiva la empresa (PAST_DUE, SUSPENDED o EXPIRED → ACTIVE) con historial y auditoría.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly db: BackofficePrismaService,
    private readonly audit: PlatformAuditService,
    private readonly lifecycle: TenantLifecycleService,
    private readonly clock: Clock,
  ) {}

  async tenantBilling(tenantId: string): Promise<TenantBillingResponse> {
    await this.requireTenant(tenantId);
    return this.db.withTenant(tenantId, async (tx) => ({
      periods: await readPeriods(tx),
      invoices: await readInvoices(tx),
    }));
  }

  async recordPayment(
    actor: PlatformPrincipal,
    tenantId: string,
    invoiceId: string,
    input: RecordPaymentRequest,
    meta: RequestMeta,
  ): Promise<{ invoice: Invoice; tenantStatus: TenantStatus }> {
    if (!UUID.safeParse(invoiceId).success) throw NOT_FOUND();
    await this.requireTenant(tenantId);
    const now = this.clock.now();
    const amount = new Prisma.Decimal(input.amount);
    if (amount.lte(0)) throw new AppError('VALIDATION_FAILED', 'El importe debe ser mayor que cero', 400);
    let reactivated = false;
    const result = await this.db.withTenant(tenantId, async (tx) => {
      const [invoice] = await tx.$queryRaw<
        { status: string; balance: Prisma.Decimal; due_date: Date; today: Date }[]
      >`
        SELECT i.status::text AS status, i.balance, i.due_date,
               (${now}::timestamptz AT TIME ZONE t.timezone)::date AS today
          FROM platform_invoices i JOIN tenants t ON t.id = i.tenant_id
         WHERE i.id = ${invoiceId}::uuid FOR UPDATE OF i`;
      if (!invoice) throw NOT_FOUND();
      // La fecha es la del comprobante: nunca futura (Fase 4.7, maqueta aprobada).
      if (input.paidAt && new Date(input.paidAt).getTime() > now.getTime()) {
        throw new AppError('VALIDATION_FAILED', 'La fecha del pago no puede ser futura', 400);
      }
      if (!['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(invoice.status)) {
        throw new AppError('CONFLICT', 'La factura no admite pagos (está pagada o anulada)', 409);
      }
      const balance = new Prisma.Decimal(invoice.balance);
      if (amount.gt(balance)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `El pago supera el saldo pendiente (${balance.toFixed(2)})`,
          400,
        );
      }
      const payment = await tx.subscriptionPayment.create({
        data: {
          tenantId,
          invoiceId,
          amount,
          method: input.method,
          reference: input.reference,
          paidAt: input.paidAt ? new Date(input.paidAt) : now,
          recordedByPlatformUserId: actor.platformUserId,
        },
        select: { id: true },
      });
      const remaining = balance.sub(amount);
      const status = remaining.isZero()
        ? 'PAID'
        : invoice.due_date.getTime() < invoice.today.getTime()
          ? 'OVERDUE'
          : 'PARTIALLY_PAID';
      await tx.$executeRaw`
        UPDATE platform_invoices SET balance = ${remaining}, status = ${status}::invoice_status, updated_at = now()
         WHERE id = ${invoiceId}::uuid`;
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'payment.recorded',
          targetType: 'subscription_payment',
          targetId: payment.id,
          tenantId,
          detail: { invoiceId, amount: amount.toFixed(2), method: input.method, invoiceStatus: status },
          ...ipOf(meta),
        },
        tx,
      );
      // ¿Queda saldo vencido? Si no, la empresa vuelve a ACTIVE en esta misma transacción.
      const [pending] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM platform_invoices WHERE status = 'OVERDUE' AND balance > 0`;
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { status: true, statusChangedAt: true },
      });
      if ((pending?.n ?? 0) === 0 && REACTIVABLE.includes(tenant.status)) {
        reactivated = await this.lifecycle.applyIn(tx, {
          tenantId,
          to: 'ACTIVE',
          reason: 'Pago registrado: sin saldo vencido',
          actorPlatformUserId: actor.platformUserId,
          ...ipOf(meta),
        });
      }
      const invoices = await readInvoices(tx);
      const updated = invoices.find((i) => i.id === invoiceId);
      if (!updated) throw NOT_FOUND();
      const current = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { status: true },
      });
      return { invoice: updated, tenantStatus: current.status };
    });
    if (reactivated) await this.lifecycle.invalidate(tenantId);
    return result;
  }

  private async requireTenant(tenantId: string): Promise<void> {
    if (!UUID.safeParse(tenantId).success) throw NOT_FOUND();
    if (!(await this.db.client.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })))
      throw NOT_FOUND();
  }
}
