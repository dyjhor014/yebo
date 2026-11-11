import type { TenantOverview } from '@yebo/contracts';
import { byUrgency, extraUsers, matches, operationLine, slugify, validSlug } from './tenants';

const base: TenantOverview = {
  id: 'x',
  slug: 'x',
  tradeName: 'X',
  legalName: 'X SAC',
  status: 'ACTIVE',
  primaryHost: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  modalities: ['LAND'],
  services: ['PASSENGER'],
  plan: null,
  usersPeak: null,
  includedUsers: null,
  outstanding: '0.00',
  overdue: false,
  currency: 'PEN',
  milestone: null,
};
const t = (o: Partial<TenantOverview>): TenantOverview => ({ ...base, ...o });

describe('lista de empresas del panel', () => {
  it('ordena por urgencia: suspendidas, vencidas por fecha de suspensión, pruebas, al día por nombre', () => {
    const list = [
      t({ tradeName: 'Beta', status: 'ACTIVE' }),
      t({ tradeName: 'Alfa', status: 'ACTIVE' }),
      t({ tradeName: 'Prueba', status: 'TRIAL' }),
      t({
        tradeName: 'Aguaytía',
        status: 'PAST_DUE',
        milestone: { kind: 'SUSPENDS_ON', date: '2026-11-19' },
      }),
      t({
        tradeName: 'Zungarococha',
        status: 'PAST_DUE',
        milestone: { kind: 'SUSPENDS_ON', date: '2026-11-15' },
      }),
      t({ tradeName: 'Cancelada', status: 'CANCELLED' }),
      t({ tradeName: 'Susp', status: 'SUSPENDED' }),
      t({ tradeName: 'Expirada', status: 'EXPIRED' }),
    ];
    expect(list.sort(byUrgency).map((x) => x.tradeName)).toEqual([
      'Susp',
      'Zungarococha', // se suspende antes (15) aunque su nombre vaya después
      'Aguaytía',
      'Expirada',
      'Prueba',
      'Alfa',
      'Beta',
      'Cancelada',
    ]);
  });

  it('filtros: atención = vencidas o suspendidas; sobre el límite = pico mayor que los incluidos', () => {
    expect(matches(t({ status: 'PAST_DUE' }), 'attention')).toBe(true);
    expect(matches(t({ status: 'SUSPENDED' }), 'attention')).toBe(true);
    expect(matches(t({ status: 'EXPIRED' }), 'attention')).toBe(false);
    expect(matches(t({ status: 'TRIAL' }), 'trial')).toBe(true);
    expect(matches(t({ status: 'ACTIVE' }), 'trial')).toBe(false);
    expect(matches(t({ usersPeak: 12, includedUsers: 10 }), 'over-limit')).toBe(true);
    expect(matches(t({ usersPeak: 10, includedUsers: 10 }), 'over-limit')).toBe(false);
    expect(matches(t({ status: 'CANCELLED' }), 'all')).toBe(true);
    expect(extraUsers(t({ usersPeak: 12, includedUsers: 10 }))).toBe(2);
    expect(extraUsers(t({ usersPeak: null, includedUsers: 10 }))).toBe(0);
  });

  it('línea de operación legible', () => {
    expect(operationLine(t({ modalities: ['RIVER'], services: ['PASSENGER', 'CARGO'] }))).toBe(
      'Fluvial · pasajeros y carga',
    );
    expect(
      operationLine(t({ modalities: ['LAND', 'RIVER'], services: ['PASSENGER', 'PARCEL', 'CARGO'] })),
    ).toBe('Terrestre y fluvial · pasajeros, encomiendas y carga');
    expect(operationLine(t({ modalities: [], services: [] }))).toBe('Sin servicios configurados');
  });
});

describe('subdominio propuesto', () => {
  it('quita tildes y símbolos y une con guiones simples', () => {
    expect(slugify('Transportes del Oriente')).toBe('transportes-del-oriente');
    expect(slugify('  Naviera Ucayali S.A.C. ')).toBe('naviera-ucayali-s-a-c');
    expect(slugify('Expreso Marañón — Línea 2')).toBe('expreso-maranon-linea-2');
    expect(slugify('Ñandú')).toBe('nandu');
    expect(slugify('a'.repeat(39) + ' bc')).toBe('a'.repeat(39));
    expect(validSlug('ok-1')).toBe(true);
    expect(validSlug('ab')).toBe(false);
    expect(validSlug('a--b')).toBe(false);
    expect(validSlug('-ab')).toBe(false);
    expect(validSlug('a'.repeat(41))).toBe(false);
  });
});
