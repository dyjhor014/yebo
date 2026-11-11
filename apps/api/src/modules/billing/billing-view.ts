import type { BillingPeriod, Invoice } from '@yebo/contracts';
import type { Prisma } from '../../generated/prisma/client';

/**
 * Lectura de períodos y facturas de UN tenant, dentro de una transacción con su contexto fijado (RLS). La comparten
 * el panel (`yebo_backoffice`) y la vista «Obligaciones con YEBO» de la empresa (`yebo_app`).
 */
type Tx = Pick<Prisma.TransactionClient, 'billingPeriod' | 'platformInvoice'>;
const day = (d: Date) => d.toISOString().slice(0, 10);

/** `staff`: incluye el motivo de las anulaciones (solo el panel). */
export async function readInvoices(tx: Tx, opts: { staff?: boolean } = {}): Promise<Invoice[]> {
  const rows = await tx.platformInvoice.findMany({
    include: {
      lines: { orderBy: { kind: 'asc' } },
      payments: { orderBy: { paidAt: 'asc' } },
    },
    orderBy: { issueDate: 'desc' },
  });
  return rows.map((i) => ({
    id: i.id,
    code: i.code,
    status: i.status,
    issueDate: day(i.issueDate),
    dueDate: day(i.dueDate),
    currency: i.currency,
    subtotal: i.subtotal.toFixed(2),
    tax: i.tax.toFixed(2),
    total: i.total.toFixed(2),
    balance: i.balance.toFixed(2),
    lines: i.lines.map((l) => ({
      kind: l.kind,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice.toFixed(2),
      amount: l.amount.toFixed(2),
    })),
    payments: i.payments.map((p) => ({
      id: p.id,
      amount: p.amount.toFixed(2),
      method: p.method,
      reference: p.reference,
      paidAt: p.paidAt.toISOString(),
      status: p.status,
      reversedAt: p.reversedAt?.toISOString() ?? null,
      ...(opts.staff ? { reversalReason: p.reversalReason } : {}),
    })),
  }));
}

export async function readPeriods(tx: Tx): Promise<BillingPeriod[]> {
  const rows = await tx.billingPeriod.findMany({
    include: { calculation: true },
    orderBy: { periodStart: 'desc' },
  });
  return rows.map((p) => ({
    id: p.id,
    periodStart: day(p.periodStart),
    periodEnd: day(p.periodEnd),
    timezone: p.timezone,
    isTrial: p.isTrial,
    status: p.status,
    calculation: p.calculation
      ? {
          usageMetric: p.calculation.usageMetric,
          dailyAggregation: p.calculation.dailyAggregation,
          metricValue: p.calculation.metricValue,
          includedUsers: p.calculation.includedUsers,
          extraUsers: p.calculation.extraUsers,
          currency: p.calculation.currency,
          totalAmount: p.calculation.totalAmount.toFixed(2),
        }
      : null,
  }));
}
