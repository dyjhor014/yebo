import { paymentConsequence } from './payment';

const invoice = {
  id: 'a',
  balance: '204.00',
  status: 'OVERDUE' as const,
  dueDate: '2026-11-08',
  currency: 'PEN',
};
const run = (amount: string | null, o: Partial<Parameters<typeof paymentConsequence>[0]> = {}) =>
  paymentConsequence({
    amount,
    invoice,
    invoices: [invoice],
    tenantStatus: 'PAST_DUE',
    suspendsOn: '15 nov 2026',
    ...o,
  });

describe('consecuencia del pago antes de registrarlo', () => {
  it('sin importe válido o por encima del saldo: bloquea', () => {
    expect(run(null)).toMatchObject({ blocking: true, tone: 'neutral' });
    expect(run('204.01')).toMatchObject({
      blocking: true,
      tone: 'danger',
      text: 'Supera el saldo pendiente de S/ 204.00. Registra como mucho ese importe.',
    });
  });

  it('el saldo exacto reactiva solo si no queda otra factura vencida', () => {
    expect(run('204.00').text).toContain('vuelve a «Al día»');
    const other = { id: 'b', balance: '99.00', status: 'OVERDUE' as const };
    expect(run('204.00', { invoices: [invoice, other] })).toMatchObject({ tone: 'warning' });
    expect(run('204.00', { invoices: [invoice, { ...other, balance: '0.00' }] }).text).toContain(
      'vuelve a «Al día»',
    );
    expect(run('204.00', { tenantStatus: 'SUSPENDED' }).text).toContain('vuelve a «Al día»');
    expect(run('204.00', { tenantStatus: 'EXPIRED' }).text).toContain('vuelve a «Al día»');
    expect(run('204.00', { tenantStatus: 'ACTIVE' }).text).toBe('La factura queda pagada.');
  });

  it('un pago parcial dice cuánto queda y qué pasa con la empresa', () => {
    expect(run('150.00')).toEqual({
      tone: 'warning',
      blocking: false,
      text: 'Quedarán S/ 54.00 pendientes: la empresa sigue con pago vencido y se suspende el 15 nov 2026 si no se regulariza.',
    });
    expect(run('150.00', { tenantStatus: 'SUSPENDED' }).text).toBe(
      'Quedarán S/ 54.00 pendientes: la empresa sigue suspendida.',
    );
    expect(run('150.00', { tenantStatus: 'ACTIVE' })).toMatchObject({
      tone: 'neutral',
      text: 'Quedarán S/ 54.00 pendientes en esta factura.',
    });
  });
});
