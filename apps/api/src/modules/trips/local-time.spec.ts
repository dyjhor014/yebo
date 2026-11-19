import { addDays, instantToLocal, localToInstant } from './local-time';

describe('hora local de la empresa', () => {
  it('Lima (UTC−5, sin horario de verano): ida y vuelta', () => {
    expect(localToInstant('2026-12-01T08:30', 'America/Lima').toISOString()).toBe('2026-12-01T13:30:00.000Z');
    expect(localToInstant('2026-12-31T23:59', 'America/Lima').toISOString()).toBe('2027-01-01T04:59:00.000Z');
    expect(instantToLocal(new Date('2027-01-01T04:59:00Z'), 'America/Lima')).toBe('2026-12-31T23:59');
    expect(instantToLocal(new Date('2026-12-01T05:00:00Z'), 'America/Lima')).toBe('2026-12-01T00:00');
  });

  it('zonas con horario de verano: el desfase de cada fecha', () => {
    expect(localToInstant('2026-07-01T12:00', 'Europe/Madrid').toISOString()).toBe(
      '2026-07-01T10:00:00.000Z',
    );
    expect(localToInstant('2026-12-01T12:00', 'Europe/Madrid').toISOString()).toBe(
      '2026-12-01T11:00:00.000Z',
    );
    // 2026-03-29 02:30 no existe en Madrid (salta de 02:00 a 03:00): se corre hacia adelante.
    expect(instantToLocal(localToInstant('2026-03-29T02:30', 'Europe/Madrid'), 'Europe/Madrid')).toBe(
      '2026-03-29T03:30',
    );
    for (const local of ['2026-01-15T00:00', '2026-06-15T23:45', '2026-10-25T01:30']) {
      expect(instantToLocal(localToInstant(local, 'Europe/Madrid'), 'Europe/Madrid')).toBe(local);
    }
  });

  it('suma días en el calendario', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
