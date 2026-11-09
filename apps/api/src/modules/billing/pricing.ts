import { Prisma } from '../../generated/prisma/client';
import { z } from 'zod';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/**
 * «De dónde sale el precio» (F4-Q1): PUNTO ÚNICO. Hoy, la versión de plan con la excepción comercial de la
 * suscripción (`subscriptions.price_override`, auditada). Si se aprueba ADR-031 (acuerdos comerciales versionados),
 * solo cambia esta función: los cálculos guardan el resultado (`pricing`), así que no hay datos que migrar.
 */
export interface PlanPricingSource {
  currency: string;
  basePrice: Decimal;
  includedUsers: number;
  extraUserPrice: Decimal;
  taxRate: Decimal;
}

const MONEY = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);
/** Campos que una excepción comercial puede sustituir. Cualquier otro campo invalida la excepción. */
export const PriceOverrideSchema = z
  .object({
    basePrice: MONEY.optional(),
    extraUserPrice: MONEY.optional(),
    includedUsers: z.number().int().nonnegative().optional(),
    reason: z.string().min(3).max(500),
  })
  .strict();

export interface ResolvedPricing {
  currency: string;
  basePrice: Decimal;
  includedUsers: number;
  extraUserPrice: Decimal;
  taxRate: Decimal;
  /** Para la auditoría del cálculo: qué se aplicó y por qué. */
  source: 'PLAN' | 'PLAN_WITH_OVERRIDE';
  overrideReason: string | null;
}

export function resolvePricing(plan: PlanPricingSource, priceOverride: unknown): ResolvedPricing {
  const base: ResolvedPricing = {
    currency: plan.currency,
    basePrice: plan.basePrice,
    includedUsers: plan.includedUsers,
    extraUserPrice: plan.extraUserPrice,
    taxRate: plan.taxRate,
    source: 'PLAN',
    overrideReason: null,
  };
  if (priceOverride === null || priceOverride === undefined) return base;
  // Una excepción mal formada no se ignora en silencio: el cierre se detiene y se alerta.
  const o = PriceOverrideSchema.parse(priceOverride);
  return {
    ...base,
    basePrice: o.basePrice !== undefined ? new Decimal(o.basePrice) : base.basePrice,
    extraUserPrice: o.extraUserPrice !== undefined ? new Decimal(o.extraUserPrice) : base.extraUserPrice,
    includedUsers: o.includedUsers ?? base.includedUsers,
    source: 'PLAN_WITH_OVERRIDE',
    overrideReason: o.reason,
  };
}

/** Valor del período a partir de la serie diaria (billing §5). La serie no puede estar vacía. */
export function periodValue(
  series: readonly number[],
  metric: 'PEAK_DAILY' | 'AVERAGE_DAILY' | 'END_OF_PERIOD',
): number {
  if (series.length === 0) throw new Error('Serie diaria vacía: nunca se factura con días faltantes');
  if (metric === 'PEAK_DAILY') return Math.max(...series);
  if (metric === 'END_OF_PERIOD') return series[series.length - 1] as number;
  return Math.ceil(series.reduce((a, b) => a + b, 0) / series.length);
}

export interface PeriodAmounts {
  extraUsers: number;
  baseAmount: Decimal;
  extraAmount: Decimal;
  subtotal: Decimal;
  taxAmount: Decimal;
  total: Decimal;
}

/** billing §5: adicionales = MAX(0, valor − incluidos); importe = base + adicionales × precio; impuesto redondeado. */
export function periodAmounts(value: number, pricing: ResolvedPricing): PeriodAmounts {
  const extraUsers = Math.max(0, value - pricing.includedUsers);
  const extraAmount = pricing.extraUserPrice.mul(extraUsers);
  const subtotal = pricing.basePrice.add(extraAmount);
  const taxAmount = subtotal.mul(pricing.taxRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return {
    extraUsers,
    baseAmount: pricing.basePrice,
    extraAmount,
    subtotal,
    taxAmount,
    total: subtotal.add(taxAmount),
  };
}

/**
 * Upgrade a mitad de período (decisión del 2026-11-10): la base del plan anterior se prorratea por los días usados
 * (redondeo a 2 decimales); los usuarios adicionales medidos en esos días se cobran a su precio.
 */
export function prorate(pricing: ResolvedPricing, daysUsed: number, daysTotal: number): ResolvedPricing {
  if (daysTotal <= 0 || daysUsed < 0 || daysUsed > daysTotal) throw new Error('Prorrateo inválido');
  return {
    ...pricing,
    basePrice: pricing.basePrice.mul(daysUsed).div(daysTotal).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
  };
}
