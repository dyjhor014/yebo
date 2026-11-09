import { journey, type JourneyInput } from './journey';

const base: JourneyInput = {
  status: 'PAST_DUE',
  timezone: 'America/Lima',
  statusChangedAt: '2026-11-09T06:00:00.000Z', // 01:00 del 9 en Lima
  trialEndsAt: null,
  cancelledAt: null,
  history: [
    { toStatus: 'TRIAL', occurredAt: '2026-08-01T15:00:00.000Z' },
    { toStatus: 'ACTIVE', occurredAt: '2026-09-01T05:30:00.000Z' },
    { toStatus: 'PAST_DUE', occurredAt: '2026-11-09T06:00:00.000Z' },
  ],
  periodLastDay: '2026-11-30',
  pastDueGraceDays: 7,
  cancelledClosingDays: 30,
};

describe('trayecto de la empresa', () => {
  it('pago vencido: parada actual, anteriores completadas y la suspensión con su fecha (gracia del plan)', () => {
    const j = journey(base);
    expect(j.stops.map((s) => [s.label, s.state, s.note])).toEqual([
      ['En prueba', 'done', 'Desde el 1 ago 2026'],
      ['Al día', 'done', 'Desde el 1 sep 2026'],
      ['Pago vencido', 'current', 'Desde el 9 nov 2026'],
      ['Suspendida', 'pending', 'Próxima parada: 16 nov 2026'],
    ]);
    expect(j.next).toBe('Se suspende el 16 nov 2026 si no se regulariza');
    const short = journey({ ...base, pastDueGraceDays: 3 });
    expect(short.next).toBe('Se suspende el 12 nov 2026 si no se regulariza');
    expect(short.stops[3]?.note).toBe('Próxima parada: 12 nov 2026');
  });

  it('las fechas se leen en la zona de la empresa', () => {
    const j = journey({ ...base, statusChangedAt: '2026-11-09T04:59:00.000Z' }); // 23:59 del 8 en Lima
    expect(j.stops[2]?.note).toBe('Desde el 8 nov 2026');
  });

  it('al día: sin parada de suspensión y con el cierre del período', () => {
    const j = journey({ ...base, status: 'ACTIVE', statusChangedAt: '2026-09-01T05:30:00.000Z' });
    expect(j.stops.map((s) => s.state)).toEqual(['done', 'current', 'pending', 'pending']);
    expect(j.stops[3]?.note).toBe('—');
    expect(j.next).toBe('Sin saldo vencido · el período cierra el 30 nov 2026');
  });

  it('cancelada y prueba vencida sustituyen la última parada', () => {
    const c = journey({ ...base, status: 'CANCELLED', cancelledAt: '2026-11-10T15:00:00.000Z' });
    expect(c.stops[3]).toMatchObject({ label: 'Cancelada', state: 'current' });
    expect(c.next).toBe('Cierre definitivo el 10 dic 2026');
    const e = journey({ ...base, status: 'EXPIRED', history: [base.history[0]!] });
    expect(e.stops.map((s) => s.state)).toEqual(['done', 'pending', 'pending', 'current']);
  });

  it('en prueba y suspendida', () => {
    expect(journey({ ...base, status: 'TRIAL', trialEndsAt: '2026-08-31T05:00:00.000Z' }).next).toBe(
      'La prueba termina el 31 ago 2026',
    );
    expect(journey({ ...base, status: 'SUSPENDED' }).next).toBe(
      'Se reactiva al registrar el pago del saldo vencido',
    );
  });
});
