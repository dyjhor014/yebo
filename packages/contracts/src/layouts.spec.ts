import {
  bed,
  boatTemplate,
  busTemplate,
  cabin,
  fastBoatTemplate,
  seat,
  seatRows,
  zone,
} from './layout-templates';
import {
  LayoutDocumentSchema,
  deckGrid,
  deriveInventory,
  emptyLayout,
  validateLayout,
  type LayoutDocument,
  type LayoutElement,
} from './layouts';

const messages = (doc: LayoutDocument) => validateLayout(doc).map((i) => i.message);

describe('plantillas y generadores a escala (Fase 6.4)', () => {
  it('las tres plantillas cumplen el esquema y las reglas', () => {
    for (const t of [busTemplate(), fastBoatTemplate(), boatTemplate()]) {
      expect(LayoutDocumentSchema.parse(t)).toEqual(t);
      expect(validateLayout(t)).toEqual([]);
    }
  });

  it('la grilla sale de las medidas reales y la escala', () => {
    expect(deckGrid({ cellCm: 50 }, { index: 0, name: 'P', lengthM: 16, widthM: 5 })).toEqual({
      cols: 10,
      rows: 32,
    });
    expect(deckGrid({ cellCm: 25 }, { index: 0, name: 'P', lengthM: 16, widthM: 5 })).toEqual({
      cols: 20,
      rows: 64,
    });
  });

  it('filas 3+2 a 25 cm: asientos de 0,5 m, pasillo de 1 m, una fila por metro; la numeración continúa', () => {
    const seats = seatRows({ cellCm: 25, zoneCode: 'Z', x: 0, y: 0, rows: 2, layout: [3, 2], firstRow: 7 });
    expect(seats).toHaveLength(10);
    expect(seats.slice(0, 5).map((s) => [s.code, s.x, s.w])).toEqual([
      ['7A', 0, 2],
      ['7B', 2, 2],
      ['7C', 4, 2],
      ['7D', 10, 2], // 3 asientos (6 celdas) + pasillo de 1 m (4 celdas)
      ['7E', 12, 2],
    ]);
    expect(seats[5]).toMatchObject({ code: '8A', y: 4 });
  });

  it('camarote de 1 a 4 camas de 1 × 2 m y cama suelta', () => {
    const [parent, ...beds] = cabin({ cellCm: 50, code: 'C1', zoneCode: 'Z', x: 0, y: 0, beds: 3 });
    expect(parent).toMatchObject({ kind: 'CABIN', capacity: 3, w: 6, h: 4, sellableAsUnit: true });
    expect(beds.map((b) => [b.code, b.parentCode, b.x, b.w, b.h])).toEqual([
      ['C1-B1', 'C1', 0, 2, 4],
      ['C1-B2', 'C1', 2, 2, 4],
      ['C1-B3', 'C1', 4, 2, 4],
    ]);
    // A 25 cm la misma cama ocupa el doble de celdas.
    expect(
      cabin({ cellCm: 25, code: 'C2', zoneCode: 'Z', x: 0, y: 0, beds: 2 }).map((e) => [
        e.code,
        e.x,
        e.w,
        e.h,
      ]),
    ).toEqual([
      ['C2', 0, 8, 8],
      ['C2-B1', 0, 4, 8],
      ['C2-B2', 4, 4, 8],
    ]);
    expect(bed({ cellCm: 25, code: 'K1', zoneCode: 'Z', x: 0, y: 0 })).toMatchObject({
      kind: 'BED',
      parentCode: null,
      w: 4,
      h: 8,
    });
  });
});

describe('validateLayout', () => {
  const bus = busTemplate();

  it('un documento vacío no se publica (sin zonas)', () => {
    expect(messages(emptyLayout('LAND'))).toEqual(['Añade al menos una zona con capacidad']);
  });

  it('medidas: múltiplos de 25 cm, hasta 30 × 100 m y 6 pisos', () => {
    const deck = { index: 0, name: 'P', lengthM: 16, widthM: 5 };
    const ok = (decks: unknown[]) =>
      LayoutDocumentSchema.safeParse({ ...emptyLayout('RIVER'), decks }).success;
    expect(ok([{ ...deck, lengthM: 16.25 }])).toBe(true);
    expect(ok([{ ...deck, lengthM: 16.1 }])).toBe(false);
    expect(ok([{ ...deck, widthM: 31 }])).toBe(false);
    expect(ok(Array.from({ length: 6 }, (_, i) => ({ ...deck, index: i })))).toBe(true);
    expect(ok(Array.from({ length: 7 }, (_, i) => ({ ...deck, index: i })))).toBe(false);
  });

  it('códigos repetidos, elementos solapados o fuera de su zona o piso', () => {
    const [first, second] = bus.elements.filter((e) => e.kind === 'SEAT') as [LayoutElement, LayoutElement];
    expect(messages({ ...bus, elements: [...bus.elements, { ...first, x: 0, y: 23 }] })).toEqual(
      expect.arrayContaining(['Código de elemento repetido: 1A', '1A se sale de su zona «Salón»']),
    );
    expect(messages({ ...bus, elements: [...bus.elements, { ...second, code: '99Z' }] })).toEqual([
      '1B y 99Z se solapan',
    ]);
    expect(messages({ ...bus, elements: [...bus.elements, { ...first, code: 'X1', x: 40 }] })).toEqual(
      expect.arrayContaining(['X1 se sale de la cubierta']),
    );
    // Si el piso se acorta, lo que queda fuera aparece.
    expect(messages({ ...bus, decks: [{ ...bus.decks[0]!, lengthM: 10 }] })).toEqual(
      expect.arrayContaining(['La zona «Salón» se sale de la cubierta']),
    );
  });

  it('zonas mixtas: asientos, camarotes y camas en la misma zona de pasajeros', () => {
    const boat = boatTemplate();
    // El salón del piso 2 se alarga hasta la popa (9 m = 18 filas) para hacer hueco al camarote y la cama.
    const mixed: LayoutDocument = {
      ...boat,
      zones: boat.zones.map((z) => (z.code === 'ASIENTOS' ? { ...z, rect: { ...z.rect, h: 16 } } : z)),
      elements: [
        ...boat.elements,
        seat({ cellCm: 50, code: 'S1', zoneCode: 'CAMAROTES', x: 4, y: 2 }),
        ...cabin({ cellCm: 50, code: 'C9', zoneCode: 'ASIENTOS', deck: 1, x: 0, y: 14, beds: 1 }),
        bed({ cellCm: 50, code: 'K1', zoneCode: 'ASIENTOS', deck: 1, x: 4, y: 14 }),
      ],
    };
    expect(validateLayout(mixed)).toEqual([]);
    const inv = deriveInventory(mixed);
    const price = (code: string) => inv.resources.find((r) => r.code === code)?.priceClassCode;
    expect([price('S1'), price('C9'), price('C9-B1'), price('K1'), price('1A')]).toEqual([
      'GENERAL',
      'CAMAROTE',
      'CAMA',
      'CAMA',
      'GENERAL',
    ]);
    // Una zona por cantidad sigue sin admitir elementos.
    expect(
      messages({
        ...boat,
        elements: [...boat.elements, seat({ cellCm: 50, code: 'S2', zoneCode: 'LIBRE', x: 0, y: 12 })],
      }),
    ).toEqual(['Un elemento de este tipo no va en la zona «Zona libre»']);
  });

  it('zonas: solapadas, servicio o dimensión que su tipo no admite, sin capacidad, sin nada que vender', () => {
    const extra = zone({
      code: 'OTRA',
      name: 'Otra',
      kind: 'HOLD',
      service: 'PASSENGER',
      rect: { x: 0, y: 22, w: 5, h: 2 },
    });
    expect(messages({ ...bus, zones: [...bus.zones, extra] })).toEqual(
      expect.arrayContaining([
        'Ese servicio no corresponde a una zona de este tipo',
        'Las zonas «Bodega de equipaje» y «Otra» se solapan',
        expect.stringMatching(/^La zona «Otra» necesita su capacidad/),
      ]),
    );
    const salonPersons = bus.zones.map((z) =>
      z.code === 'SALON' ? { ...z, capacity: [{ dimension: 'PERSONS' as const, value: 40 }] } : z,
    );
    expect(messages({ ...bus, zones: salonPersons })).toEqual(['Una zona de este tipo no mide personas']);
    expect(messages({ ...bus, elements: bus.elements.filter((e) => e.kind !== 'SEAT') })).toEqual([
      'La zona «Salón» no tiene ningún elemento que vender',
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
    expect(messages(set('C1-B2', { x: 8 }))).toEqual(
      expect.arrayContaining(['La cama C1-B2 se sale de su camarote C1']),
    );
    const alone = { ...boat, elements: boat.elements.filter((e) => e.parentCode !== 'C4') };
    expect(messages(alone)).toEqual(['El camarote C4 no tiene camas: ya se vende completo']);
  });
});

describe('deriveInventory', () => {
  it('lancha de 3 pisos: asientos, camas, camarotes padre vendibles completos, pools por zona y aforo', () => {
    const inv = deriveInventory(boatTemplate());
    expect(inv.summary).toEqual({
      seats: 36,
      beds: 8,
      cabins: 4,
      vehicleSlots: 0,
      assignedPersons: 44,
      pooledPersons: 70,
      totalPersons: 110,
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
      { scope: 'ZONE', zoneCode: 'LIBRE', dimension: 'PERSONS', capacity: 40 },
      { scope: 'ZONE', zoneCode: 'CUBIERTA', dimension: 'WEIGHT_KG', capacity: 12000 },
      { scope: 'ZONE', zoneCode: 'CUBIERTA', dimension: 'LINEAR_M', capacity: 20 },
      { scope: 'ZONE', zoneCode: 'TERRAZA', dimension: 'PERSONS', capacity: 30 },
      { scope: 'ZONE', zoneCode: 'BODEGA', dimension: 'WEIGHT_KG', capacity: 8000 },
      { scope: 'ZONE', zoneCode: 'BODEGA', dimension: 'VOLUME_M3', capacity: 40 },
      { scope: 'VEHICLE', zoneCode: null, dimension: 'PERSONS', capacity: 110 },
    ]);
  });

  it('bus: 40 asientos GENERAL; un camarote sin camas se vende entero', () => {
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
