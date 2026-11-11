import { boatTemplate, busTemplate, cabin, seatRows, zone } from './layout-templates';
import {
  LayoutDocumentSchema,
  deriveInventory,
  emptyLayout,
  validateLayout,
  type LayoutDocument,
  type LayoutElement,
} from './layouts';

const messages = (doc: LayoutDocument) => validateLayout(doc).map((i) => i.message);

describe('plantillas y generadores (Fase 6.3)', () => {
  it('las dos plantillas cumplen el esquema y las reglas', () => {
    for (const t of [busTemplate(), boatTemplate()]) {
      expect(LayoutDocumentSchema.parse(t)).toEqual(t);
      expect(validateLayout(t)).toEqual([]);
    }
  });

  it('filas 2+2: códigos 1A…10D con una columna de pasillo', () => {
    const seats = seatRows({ zoneCode: 'Z', x: 0, y: 0, rows: 10, layout: [2, 2] });
    expect(seats).toHaveLength(40);
    expect(seats.slice(0, 4).map((s) => [s.code, s.x])).toEqual([
      ['1A', 0],
      ['1B', 1],
      ['1C', 3],
      ['1D', 4],
    ]);
    expect(seats.at(-1)?.code).toBe('10D');
  });

  it('camarote de 3 camas: padre para 3 y camas C1-B1…C1-B3 dentro de él', () => {
    const [parent, ...beds] = cabin({ code: 'C1', zoneCode: 'Z', x: 0, y: 0, beds: 3 });
    expect(parent).toMatchObject({ kind: 'CABIN', capacity: 3, w: 3, sellableAsUnit: true });
    expect(beds.map((b) => [b.code, b.parentCode])).toEqual([
      ['C1-B1', 'C1'],
      ['C1-B2', 'C1'],
      ['C1-B3', 'C1'],
    ]);
  });
});

describe('validateLayout', () => {
  const bus = busTemplate();

  it('un documento vacío no se publica (sin zonas)', () => {
    expect(messages(emptyLayout('LAND'))).toEqual(['Añade al menos una zona con capacidad']);
  });

  it('códigos repetidos, elementos solapados o fuera de su zona o cubierta', () => {
    const [first, second] = bus.elements.filter((e) => e.kind === 'SEAT') as [LayoutElement, LayoutElement];
    expect(messages({ ...bus, elements: [...bus.elements, { ...first, x: 0, y: 12 }] })).toEqual(
      expect.arrayContaining(['Código de elemento repetido: 1A', '1A se sale de su zona SALON']),
    );
    expect(messages({ ...bus, elements: [...bus.elements, { ...second, code: '99Z' }] })).toEqual([
      '1B y 99Z se solapan',
    ]);
    expect(messages({ ...bus, elements: [...bus.elements, { ...first, code: 'X1', x: 40 }] })).toEqual(
      expect.arrayContaining(['X1 se sale de la cubierta']),
    );
    expect(
      messages({ ...bus, elements: [...bus.elements, { ...first, code: 'X2', zoneCode: null, x: 2, y: 0 }] }),
    ).toEqual(['X2 debe estar en una zona']);
  });

  it('zonas: solapadas, servicio o dimensión que su tipo no admite, sin capacidad, sin nada que vender', () => {
    const extra = zone({
      code: 'OTRA',
      name: 'Otra',
      kind: 'HOLD',
      service: 'PASSENGER',
      rect: { x: 0, y: 12, w: 5, h: 2 },
    });
    expect(messages({ ...bus, zones: [...bus.zones, extra] })).toEqual(
      expect.arrayContaining([
        'Ese servicio no corresponde a una zona de este tipo',
        'Las zonas BODEGA y OTRA se solapan',
        expect.stringMatching(/^La zona OTRA necesita su capacidad/),
      ]),
    );
    const salonPersons = bus.zones.map((z) =>
      z.code === 'SALON' ? { ...z, capacity: [{ dimension: 'PERSONS' as const, value: 40 }] } : z,
    );
    expect(messages({ ...bus, zones: salonPersons })).toEqual(['Una zona de este tipo no mide personas']);
    expect(messages({ ...bus, elements: bus.elements.filter((e) => e.kind !== 'SEAT') })).toEqual([
      'La zona SALON no tiene ningún elemento que vender',
    ]);
  });

  it('camarotes: capacidad = suma de sus camas; camas dentro y de 1 o 2; vender completo solo con camas', () => {
    const boat = boatTemplate();
    const set = (code: string, patch: Partial<LayoutElement>) => ({
      ...boat,
      elements: boat.elements.map((e) => (e.code === code ? { ...e, ...patch } : e)),
    });
    expect(messages(set('C1', { capacity: 3 }))).toEqual(['El camarote C1 es para 2 (la suma de sus camas)']);
    expect(messages(set('C1-B1', { capacity: 3 }))).toEqual(
      expect.arrayContaining(['Una cama es para 1 o 2 personas']),
    );
    expect(messages(set('C1-B2', { x: 5 }))).toEqual(
      expect.arrayContaining(['La cama C1-B2 se sale de su camarote C1']),
    );
    const alone = { ...boat, elements: boat.elements.filter((e) => e.parentCode !== 'C4') };
    expect(messages(alone)).toEqual(['El camarote C4 no tiene camas: ya se vende completo']);
    expect(messages(set('C1-B1', { parentCode: 'C2' }))).toEqual(
      expect.arrayContaining(['La cama C1-B1 se sale de su camarote C2']),
    );
  });
});

describe('deriveInventory', () => {
  it('lancha: camas vendibles, camarotes padre vendibles completos, pools por zona y aforo total', () => {
    const inv = deriveInventory(boatTemplate());
    expect(inv.summary).toEqual({
      seats: 0,
      beds: 8,
      cabins: 4,
      vehicleSlots: 0,
      assignedPersons: 8,
      pooledPersons: 60,
      totalPersons: 70,
    });
    expect(inv.resources.find((r) => r.code === 'C1')).toMatchObject({
      isSellable: false,
      sellableAsUnit: true,
      priceClassCode: 'CAMAROTE',
    });
    expect(inv.resources.find((r) => r.code === 'C1-B1')).toMatchObject({
      isSellable: true,
      parentCode: 'C1',
      priceClassCode: 'CAMA',
    });
    expect(inv.pools).toEqual([
      { scope: 'ZONE', zoneCode: 'LIBRE', dimension: 'PERSONS', capacity: 60 },
      { scope: 'ZONE', zoneCode: 'CUBIERTA', dimension: 'WEIGHT_KG', capacity: 20000 },
      { scope: 'ZONE', zoneCode: 'CUBIERTA', dimension: 'LINEAR_M', capacity: 30 },
      { scope: 'ZONE', zoneCode: 'BODEGA', dimension: 'WEIGHT_KG', capacity: 8000 },
      { scope: 'ZONE', zoneCode: 'BODEGA', dimension: 'VOLUME_M3', capacity: 40 },
      { scope: 'VEHICLE', zoneCode: null, dimension: 'PERSONS', capacity: 70 },
    ]);
  });

  it('bus: 40 asientos GENERAL y bodega de equipaje; un camarote sin camas se vende entero', () => {
    const inv = deriveInventory(busTemplate());
    expect(inv.summary).toMatchObject({ seats: 40, assignedPersons: 40, pooledPersons: 0, totalPersons: 40 });
    expect(new Set(inv.resources.map((r) => r.priceClassCode))).toEqual(new Set(['GENERAL']));
    const boat = boatTemplate();
    const alone = deriveInventory({
      ...boat,
      elements: boat.elements
        .filter((e) => e.parentCode !== 'C4')
        .map((e) => (e.code === 'C4' ? { ...e, sellableAsUnit: false } : e)),
    });
    expect(alone.resources.find((r) => r.code === 'C4')).toMatchObject({ isSellable: true, capacity: 2 });
  });
});
