import type { Invoice, TenantStatus } from '@yebo/contracts';
import { compareAmounts, money, subtractAmounts } from './format';

/**
 * Consecuencia de un pago antes de registrarlo (maqueta 4.7 v2): el staff ve qué pasará con la factura y con la
 * empresa según el importe. Debe coincidir con la regla de la API: la empresa vuelve a «Al día» solo cuando no le
 * queda saldo vencido en ninguna factura.
 */
export type Consequence = { tone: 'neutral' | 'warning' | 'danger'; text: string; blocking: boolean };

export function paymentConsequence(input: {
  amount: string | null;
  invoice: Pick<Invoice, 'id' | 'balance' | 'status' | 'dueDate' | 'currency'>;
  invoices: Pick<Invoice, 'id' | 'balance' | 'status'>[];
  tenantStatus: TenantStatus;
  suspendsOn: string | null;
}): Consequence {
  const { amount, invoice } = input;
  const cur = invoice.currency;
  if (amount === null)
    return { tone: 'neutral', text: 'Escribe un importe, por ejemplo 204.00.', blocking: true };
  const cmp = compareAmounts(amount, invoice.balance);
  if (cmp > 0) {
    return {
      tone: 'danger',
      text: `Supera el saldo pendiente de ${money(invoice.balance, cur)}. Registra como mucho ese importe.`,
      blocking: true,
    };
  }
  const otherOverdue = input.invoices.some(
    (i) => i.id !== invoice.id && i.status === 'OVERDUE' && compareAmounts(i.balance, '0.00') > 0,
  );
  // Los mismos estados que reactiva la API al quedar sin saldo vencido (billing.service, REACTIVABLE).
  const blocked = ['PAST_DUE', 'SUSPENDED', 'EXPIRED'].includes(input.tenantStatus);
  if (cmp === 0) {
    if (blocked && !otherOverdue) {
      return {
        tone: 'neutral',
        text: 'Con este pago no queda saldo vencido: la empresa vuelve a «Al día» en ese momento.',
        blocking: false,
      };
    }
    if (blocked) {
      return {
        tone: 'warning',
        text: 'Esta factura queda pagada, pero la empresa tiene otra factura vencida: sigue sin volver a «Al día».',
        blocking: false,
      };
    }
    return { tone: 'neutral', text: 'La factura queda pagada.', blocking: false };
  }
  const left = money(subtractAmounts(invoice.balance, amount), cur);
  if (input.tenantStatus === 'PAST_DUE') {
    return {
      tone: 'warning',
      text: `Quedarán ${left} pendientes: la empresa sigue con pago vencido${
        input.suspendsOn ? ` y se suspende el ${input.suspendsOn} si no se regulariza` : ''
      }.`,
      blocking: false,
    };
  }
  if (input.tenantStatus === 'SUSPENDED') {
    return {
      tone: 'warning',
      text: `Quedarán ${left} pendientes: la empresa sigue suspendida.`,
      blocking: false,
    };
  }
  return { tone: 'neutral', text: `Quedarán ${left} pendientes en esta factura.`, blocking: false };
}
