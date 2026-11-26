import { dayOf, formatDuration, parseDuration } from './durations';

describe('duraciones de las rutas', () => {
  it('lee lo que se escribe a mano', () => {
    expect(parseDuration('12 h')).toBe(720);
    expect(parseDuration('1 d 12 h')).toBe(2160);
    expect(parseDuration('90 min')).toBe(90);
    expect(parseDuration('2h15m')).toBe(135);
    expect(parseDuration('12:30')).toBe(750);
    expect(parseDuration('36')).toBe(2160);
    expect(parseDuration('1,5 h')).toBe(90);
    expect(parseDuration(' 0 min ')).toBe(0);
  });

  it('rechaza lo que no entiende', () => {
    for (const t of ['', 'mañana', '12 x', '1 d y algo', '12:75', 'h']) expect(parseDuration(t)).toBeNull();
  });

  it('escribe y vuelve a leer lo mismo', () => {
    expect(formatDuration(5040)).toBe('3 d 12 h');
    expect(formatDuration(750)).toBe('12 h 30 min');
    expect(formatDuration(0)).toBe('0 min');
    for (const m of [0, 45, 60, 720, 2160, 5040, 43_200]) expect(parseDuration(formatDuration(m))).toBe(m);
    expect([dayOf(0), dayOf(720), dayOf(2160), dayOf(5040)]).toEqual([1, 1, 2, 4]);
  });
});
