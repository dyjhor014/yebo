import { CreateScheduleRequestSchema, fromRRule, occursOn, toRRule } from './schedules';

describe('recurrencia (subconjunto de RRULE, F7-Q2)', () => {
  it('normaliza los días en orden de la semana y se lee de vuelta', () => {
    expect(toRRule({ frequency: 'DAILY' })).toBe('FREQ=DAILY');
    expect(toRRule({ frequency: 'WEEKLY', weekdays: ['FR', 'MO', 'WE'] })).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(fromRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toEqual({
      frequency: 'WEEKLY',
      weekdays: ['MO', 'WE', 'FR'],
    });
    expect(fromRRule('FREQ=DAILY')).toEqual({ frequency: 'DAILY' });
    expect(() => fromRRule('FREQ=MONTHLY')).toThrow('RRULE no soportada');
  });

  it('el día de la semana de cada fecha (2026-11-23 es lunes)', () => {
    const weekly = { frequency: 'WEEKLY' as const, weekdays: ['MO' as const, 'SU' as const] };
    expect(
      ['2026-11-23', '2026-11-24', '2026-11-28', '2026-11-29', '2026-11-30'].map((d) => occursOn(weekly, d)),
    ).toEqual([true, false, false, true, true]);
    expect(occursOn({ frequency: 'DAILY' }, '2026-11-24')).toBe(true);
  });
});

describe('CreateScheduleRequestSchema', () => {
  const body = (over: object = {}) => ({
    code: ' pcl-lun ',
    routeId: '0190f0a0-0000-7000-8000-000000000001',
    recurrence: { frequency: 'WEEKLY', weekdays: ['MO'] },
    departureTime: '07:00',
    validFrom: '2026-12-01',
    validTo: null,
    excludedDates: [],
    vehicleId: null,
    layout: null,
    ...over,
  });
  const issues = (over: object) =>
    CreateScheduleRequestSchema.safeParse(body(over)).error?.issues.map((i) => [i.path.join('.'), i.message]);

  it('normaliza el código y rechaza lo que no es del subconjunto', () => {
    expect(CreateScheduleRequestSchema.parse(body()).code).toBe('PCL-LUN');
    expect(issues({ validTo: '2026-12-01' })).toEqual([['validTo', 'El fin es posterior al inicio']]);
    expect(issues({ excludedDates: ['2026-12-08', '2026-12-08'] })).toEqual([
      ['excludedDates', 'Fechas excluidas repetidas'],
    ]);
    expect(issues({ layout: { layoutId: '0190f0a0-0000-7000-8000-000000000002', version: 1 } })).toEqual([
      ['layout', 'Elige la unidad antes que el plano'],
    ]);
    for (const over of [
      { recurrence: { frequency: 'MONTHLY' } },
      { recurrence: { frequency: 'WEEKLY', weekdays: [] } },
      { recurrence: { frequency: 'WEEKLY', weekdays: ['MO', 'MO'] } },
      { recurrence: { frequency: 'DAILY', weekdays: ['MO'] } },
      { departureTime: '7:00' },
      { departureTime: '24:00' },
      {
        excludedDates: Array.from(
          { length: 101 },
          (_, i) => `2027-01-${String((i % 28) + 1).padStart(2, '0')}`,
        ),
      },
    ]) {
      expect(CreateScheduleRequestSchema.safeParse(body(over)).success).toBe(false);
    }
  });
});
