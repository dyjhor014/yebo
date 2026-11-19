import {
  CreateFaresRequestSchema,
  FareQuoteQuerySchema,
  farePhase,
  layoutPriceClasses,
  routePairs,
} from './fares';
import { boatTemplate, busTemplate, pooledZone } from './layout-templates';

const A = '0190f0a0-0000-7000-8000-00000000000a';
const B = '0190f0a0-0000-7000-8000-00000000000b';
const C = '0190f0a0-0000-7000-8000-00000000000c';
const D = '0190f0a0-0000-7000-8000-00000000000d';

const stop = (locationId: string, allowsBoarding = true, allowsAlighting = true) => ({
  locationId,
  allowsBoarding,
  allowsAlighting,
});
const pair = (origin: string, destination: string) => ({ origin, destination });

describe('routePairs', () => {
  it('sube en una parada y baja en otra posterior, respetando subir y bajar', () => {
    // A (solo sube) → B (sube y baja) → C (solo baja: no sube nadie) → D (destino)
    expect(routePairs([stop(A, true, false), stop(B), stop(C, false, true), stop(D, false, true)])).toEqual([
      pair(A, B),
      pair(A, C),
      pair(A, D),
      pair(B, C),
      pair(B, D),
    ]);
  });

  it('ida y vuelta: sin A → A y cada par una vez', () => {
    expect(routePairs([stop(A, true, false), stop(B), stop(A, false, true)])).toEqual([
      pair(A, B),
      pair(B, A),
    ]);
    // A → B → A → B: A → B aparece una vez (por su primera aparición).
    expect(routePairs([stop(A), stop(B), stop(A), stop(B)])).toEqual([pair(A, B), pair(B, A)]);
  });
});

describe('layoutPriceClasses', () => {
  it('bus: solo GENERAL (la bodega de equipaje no es tarifa de pasaje)', () => {
    expect(layoutPriceClasses(busTemplate(), 'PASSENGER')).toEqual(['GENERAL']);
    expect(layoutPriceClasses(busTemplate(), 'VEHICLE_TRANSPORT')).toEqual([]);
  });

  it('lancha: camas, camarote completo, asientos y zona libre; con clase propia en la zona, la de la zona', () => {
    const boat = boatTemplate();
    expect(layoutPriceClasses(boat, 'PASSENGER')).toEqual(['CAMA', 'CAMAROTE', 'GENERAL']);
    boat.zones.push(
      pooledZone('HAMACAS', 'Hamacas', 'HAMMOCK', 'PASSENGER', { x: 0, y: 0, w: 2, h: 2 }, [
        { dimension: 'PERSONS', value: 10 },
      ]),
    );
    const terrace = boat.zones.find((z) => z.code === 'TERRAZA');
    if (terrace) terrace.priceClassCode = 'TERRAZA';
    expect(layoutPriceClasses(boat, 'PASSENGER')).toEqual([
      'CAMA',
      'CAMAROTE',
      'GENERAL',
      'HAMACA',
      'TERRAZA',
    ]);
  });
});

describe('CreateFaresRequestSchema', () => {
  const body = (over: object = {}, items: object[] = [{}]) => ({
    service: 'PASSENGER',
    validFrom: '2026-12-01',
    validTo: null,
    items: items.map((i) => ({
      originLocationId: A,
      destinationLocationId: B,
      priceClassCode: ' general ',
      amount: ' 45.5 ',
      ...i,
    })),
    ...over,
  });

  it('normaliza la clase y el monto', () => {
    const r = CreateFaresRequestSchema.parse(body());
    expect(r.items[0]).toMatchObject({ priceClassCode: 'GENERAL', amount: '45.50' });
    expect(CreateFaresRequestSchema.parse(body({}, [{ amount: '99999.99' }])).items[0]?.amount).toBe(
      '99999.99',
    );
  });

  it('rechaza montos no positivos o con más de 2 decimales, fechas al revés, pares iguales y repetidos', () => {
    const issues = (b: object) =>
      CreateFaresRequestSchema.safeParse(b).error?.issues.map((i) => [i.path.join('.'), i.message]);
    for (const amount of ['0', '0.00', '-5', '10.505', '100000', '1e3', 'abc', '']) {
      expect(CreateFaresRequestSchema.safeParse(body({}, [{ amount }])).success).toBe(false);
    }
    expect(issues(body({ validTo: '2026-12-01' }))).toEqual([['validTo', 'El fin es posterior al inicio']]);
    expect(issues(body({}, [{ destinationLocationId: A }]))).toEqual([
      ['items.0.destinationLocationId', 'El origen y el destino son distintos'],
    ]);
    expect(issues(body({}, [{}, { priceClassCode: 'GENERAL' }, { priceClassCode: 'VIP' }]))).toEqual([
      ['items.1.priceClassCode', 'Ese par y esa clase ya están en la lista'],
    ]);
    expect(CreateFaresRequestSchema.safeParse(body({ service: 'CARGO' })).success).toBe(false);
    expect(
      CreateFaresRequestSchema.safeParse(body({}, [{ priceClassCode: 'clase con espacios' }])).success,
    ).toBe(false);
    expect(CreateFaresRequestSchema.safeParse(body({ currency: 'USD' })).success).toBe(false);
  });

  it('la consulta de precio: servicio por defecto PASSENGER y fecha opcional', () => {
    expect(FareQuoteQuerySchema.parse({ origin: A, destination: C, priceClass: 'vip' })).toEqual({
      origin: A,
      destination: C,
      priceClass: 'VIP',
      service: 'PASSENGER',
    });
  });
});

describe('farePhase', () => {
  const today = '2026-11-19';
  it.each([
    [{ status: 'ACTIVE', validFrom: '2026-11-20', validTo: null }, 'SCHEDULED'],
    [{ status: 'ACTIVE', validFrom: '2026-11-19', validTo: null }, 'CURRENT'],
    [{ status: 'ACTIVE', validFrom: '2026-01-01', validTo: '2026-11-20' }, 'CURRENT'],
    [{ status: 'ACTIVE', validFrom: '2026-01-01', validTo: '2026-11-19' }, 'ENDED'],
    [{ status: 'CANCELLED', validFrom: '2026-12-01', validTo: null }, 'CANCELLED'],
  ] as const)('%o → %s', (fare, phase) => {
    expect(farePhase(fare, today)).toBe(phase);
  });
});
