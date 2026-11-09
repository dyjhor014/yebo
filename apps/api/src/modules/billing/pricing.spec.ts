import { Prisma } from '../../generated/prisma/client';
import { periodAmounts, periodValue, prorate, resolvePricing } from './pricing';

const D = (v: string) => new Prisma.Decimal(v);
const PLAN = {
  currency: 'PEN',
  basePrice: D('99.00'),
  includedUsers: 5,
  extraUserPrice: D('15.00'),
  taxRate: D('0'),
};

describe('precio e importe del período (billing §5, F4-Q1)', () => {
  it('el ejemplo de billing §5: pico 12, 5 incluidos → 7 adicionales → 99 + 7 × 15 = 204', () => {
    const a = periodAmounts(12, resolvePricing(PLAN, null));
    expect(a.extraUsers).toBe(7);
    expect(a.total.toFixed(2)).toBe('204.00');
  });

  it('por debajo de los incluidos no hay adicionales', () => {
    expect(periodAmounts(3, resolvePricing(PLAN, null)).total.toFixed(2)).toBe('99.00');
  });

  it('las tres métricas del período', () => {
    const series = [2, 5, 3, 4];
    expect(periodValue(series, 'PEAK_DAILY')).toBe(5);
    expect(periodValue(series, 'AVERAGE_DAILY')).toBe(4); // ceil(3,5)
    expect(periodValue(series, 'END_OF_PERIOD')).toBe(4);
    expect(() => periodValue([], 'PEAK_DAILY')).toThrow(/días faltantes/);
  });

  it('la excepción comercial sustituye solo lo que indica y queda registrada', () => {
    const p = resolvePricing(PLAN, { includedUsers: 10, reason: 'Acuerdo de lanzamiento' });
    expect(p).toMatchObject({
      includedUsers: 10,
      source: 'PLAN_WITH_OVERRIDE',
      overrideReason: 'Acuerdo de lanzamiento',
    });
    expect(p.basePrice.toFixed(2)).toBe('99.00');
    expect(periodAmounts(12, p).total.toFixed(2)).toBe('129.00');
  });

  it('una excepción mal formada detiene el cálculo en vez de ignorarse', () => {
    expect(() => resolvePricing(PLAN, { basePrice: 'gratis', reason: 'x x x' })).toThrow();
    expect(() => resolvePricing(PLAN, { descuento: 50, reason: 'x x x' })).toThrow();
  });

  it('impuesto sobre el subtotal, redondeado a 2 decimales', () => {
    const a = periodAmounts(6, resolvePricing({ ...PLAN, taxRate: D('0.18') }, null)); // 99 + 15 = 114
    expect(a.taxAmount.toFixed(2)).toBe('20.52');
    expect(a.total.toFixed(2)).toBe('134.52');
  });

  it('prorrateo por upgrade: solo la base, redondeada; los adicionales a su precio', () => {
    const p = prorate(resolvePricing(PLAN, null), 20, 31);
    expect(p.basePrice.toFixed(2)).toBe('63.87');
    expect(periodAmounts(12, p).total.toFixed(2)).toBe('168.87');
    expect(() => prorate(resolvePricing(PLAN, null), 32, 31)).toThrow();
  });
});
