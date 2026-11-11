import { z } from 'zod';
import { MoneySchema } from './catalog';
import { TenantStatusSchema } from './tenants';

/**
 * Períodos, importes y cobro (Fase 4.5; billing §5–7). Importes como texto decimal («204.00»), nunca `float`.
 */
export const InvoiceStatusSchema = z.enum(['DRAFT', 'ISSUED', 'PAID', 'PARTIALLY_PAID', 'VOID', 'OVERDUE']);
export const PaymentMethodSchema = z.enum(['BANK_TRANSFER', 'CASH', 'CARD', 'OTHER']);

export const InvoiceLineSchema = z.object({
  kind: z.enum(['BASE', 'EXTRA_USERS', 'ADDON', 'ADJUSTMENT', 'CREDIT']),
  description: z.string(),
  quantity: z.number().int(),
  unitPrice: z.string(),
  amount: z.string(),
});

export const PaymentSchema = z.object({
  id: z.string(),
  amount: z.string(),
  method: PaymentMethodSchema,
  reference: z.string(),
  paidAt: z.iso.datetime(),
  status: z.enum(['CONFIRMED', 'REVERSED']),
  /** Anulación (Fase 4.7b). La empresa ve la fecha; el motivo solo lo ve el staff. */
  reversedAt: z.iso.datetime().nullable(),
  reversalReason: z.string().nullable().optional(),
});

export const InvoiceSchema = z.object({
  id: z.string(),
  code: z.string(),
  status: InvoiceStatusSchema,
  issueDate: z.iso.date(),
  dueDate: z.iso.date(),
  currency: z.string(),
  subtotal: z.string(),
  tax: z.string(),
  total: z.string(),
  balance: z.string(),
  lines: z.array(InvoiceLineSchema),
  payments: z.array(PaymentSchema),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

export const BillingPeriodSchema = z.object({
  id: z.string(),
  periodStart: z.iso.date(),
  /** Exclusivo: el período cubre [periodStart, periodEnd). */
  periodEnd: z.iso.date(),
  timezone: z.string(),
  isTrial: z.boolean(),
  status: z.enum(['OPEN', 'CLOSING', 'CLOSED']),
  calculation: z
    .object({
      usageMetric: z.enum(['PEAK_DAILY', 'AVERAGE_DAILY', 'END_OF_PERIOD']),
      dailyAggregation: z.enum(['PEAK_CONCURRENT', 'DISTINCT_ACTIVE']),
      metricValue: z.number().int(),
      includedUsers: z.number().int(),
      extraUsers: z.number().int(),
      currency: z.string(),
      totalAmount: z.string(),
    })
    .nullable(),
});
export type BillingPeriod = z.infer<typeof BillingPeriodSchema>;

/** Panel: facturación de una empresa. */
export const TenantBillingResponseSchema = z.object({
  periods: z.array(BillingPeriodSchema),
  invoices: z.array(InvoiceSchema),
});
export type TenantBillingResponse = z.infer<typeof TenantBillingResponseSchema>;

/** Panel: pago registrado a mano por el staff (sin pagos simulados). */
export const RecordPaymentRequestSchema = z
  .object({
    amount: MoneySchema,
    method: PaymentMethodSchema,
    reference: z.string().trim().min(1).max(120),
    paidAt: z.iso.datetime().optional(),
  })
  .strict();
export type RecordPaymentRequest = z.infer<typeof RecordPaymentRequestSchema>;
/** Panel: anular un pago (Fase 4.7b). Motivo obligatorio; repone el saldo de la factura. */
export const ReversePaymentRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type ReversePaymentRequest = z.infer<typeof ReversePaymentRequestSchema>;
export const RecordPaymentResponseSchema = z.object({
  invoice: InvoiceSchema,
  tenantStatus: TenantStatusSchema,
});
export type RecordPaymentResponse = z.infer<typeof RecordPaymentResponseSchema>;

/** Empresa: «Obligaciones con YEBO» (BILLING_SELF). */
export const ObligationsResponseSchema = z.object({
  /** Saldo pendiente por moneda. */
  outstanding: z.array(z.object({ currency: z.string(), amount: z.string() })),
  currentPeriod: z
    .object({ periodStart: z.iso.date(), periodEnd: z.iso.date(), isTrial: z.boolean() })
    .nullable(),
  invoices: z.array(InvoiceSchema),
});
export type ObligationsResponse = z.infer<typeof ObligationsResponseSchema>;

/**
 * Panel: cambio de plan (decisión del 2026-11-10). Upgrade: aplica desde hoy (corta y prorratea el período en curso).
 * Downgrade: desde el período siguiente.
 */
export const ChangePlanRequestSchema = z
  .object({ planVersionId: z.uuid(), reason: z.string().trim().min(3).max(500) })
  .strict();
export type ChangePlanRequest = z.infer<typeof ChangePlanRequestSchema>;
export const ChangePlanResponseSchema = z.object({
  kind: z.enum(['UPGRADE', 'DOWNGRADE']),
  /** Día (local de la empresa) desde el que rige el plan nuevo. */
  effectiveOn: z.iso.date(),
});
export type ChangePlanResponse = z.infer<typeof ChangePlanResponseSchema>;
