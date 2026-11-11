import { addDays, compareAmounts, date, money, parseAmount, period, subtractAmounts, today } from './format';

describe('formato del panel (es-PE)', () => {
  it('importes con separador de miles y 2 decimales, sin pasar por float', () => {
    expect(money('1338.5')).toBe('S/ 1,338.50');
    expect(money('204')).toBe('S/ 204.00');
    expect(money('0.00')).toBe('S/ 0.00');
    expect(money('1234567.89')).toBe('S/ 1,234,567.89');
    expect(money('999.99')).toBe('S/ 999.99');
    expect(money('-15.00')).toBe('-S/ 15.00');
    expect(money('10.00', 'USD')).toBe('US$ 10.00');
    expect(money('10.00', 'EUR')).toBe('EUR 10.00');
    expect(() => money('1e3')).toThrow();
  });

  it('fechas con día, mes abreviado y año', () => {
    expect(date('2026-11-15')).toBe('15 nov 2026');
    expect(date('2026-01-01T05:00:00Z')).toBe('1 ene 2026');
    expect(date('2026-12-31')).toBe('31 dic 2026');
    expect(() => date('15/11/2026')).toThrow();
  });

  it('períodos [inicio, fin) en el mismo mes, entre meses y entre años', () => {
    expect(period('2026-11-01', '2026-12-01')).toBe('1 – 30 nov 2026');
    expect(period('2026-11-09', '2026-12-09')).toBe('9 nov – 8 dic 2026');
    expect(period('2026-12-15', '2027-01-15')).toBe('15 dic 2026 – 14 ene 2027');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('hoy en la zona de la empresa, no en UTC', () => {
    expect(today('America/Lima', new Date('2026-11-09T04:30:00Z'))).toBe('2026-11-08');
    expect(today('America/Lima', new Date('2026-11-09T05:00:00Z'))).toBe('2026-11-09');
  });

  it('importe escrito: acepta punto, coma decimal, miles y símbolo; rechaza lo ambiguo o con más decimales', () => {
    expect(parseAmount('204.00')).toBe('204.00');
    expect(parseAmount('204,00')).toBe('204.00');
    expect(parseAmount('204,5')).toBe('204.50');
    expect(parseAmount(' S/ 1,338.50 ')).toBe('1338.50');
    expect(parseAmount('1,338')).toBe('1338.00');
    expect(parseAmount('007')).toBe('7.00');
    expect(parseAmount('204.001')).toBeNull();
    expect(parseAmount('2,04.00')).toBeNull();
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('0,00')).toBeNull();
    expect(parseAmount('-5')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });

  it('compara y resta en céntimos', () => {
    expect(compareAmounts('204.00', '204.00')).toBe(0);
    expect(compareAmounts('204.01', '204.00')).toBe(1);
    expect(compareAmounts('9.99', '10.00')).toBe(-1);
    expect(subtractAmounts('204.00', '100.00')).toBe('104.00');
    expect(subtractAmounts('204.00', '203.99')).toBe('0.01');
    expect(subtractAmounts('1.00', '1.50')).toBe('-0.50');
  });
});
