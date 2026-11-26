/**
 * Planos del criterio de la Fase 6 (6.6), compartidos con el criterio de la Fase 7 (7.7) y su E2E: la lancha con
 * camarotes, zona libre, cubierta de carga y bodega; el bus de dos pisos con su bodega de equipaje; y la camioneta
 * pickup 4×4. Las cifras que deben dar están escritas a mano en cada prueba, no se calculan con deriveInventory.
 */
import { cabin, emptyLayout, pooledZone, seat, seatRows, zone, type LayoutDocument } from '@yebo/contracts';

// --- La lancha: piso 1 (16 × 5 m) con camarotes, zona libre y cubierta de carga; piso 2, la bodega ----------------
export const lanchaFloors: LayoutDocument = {
  ...emptyLayout('RIVER'),
  decks: [
    { index: 0, name: 'Piso 1', lengthM: 16, widthM: 5 },
    { index: 1, name: 'Bodega', lengthM: 16, widthM: 5 },
  ],
  zones: [
    zone({
      code: 'CAMAROTES',
      name: 'Camarotes',
      kind: 'CABINS',
      service: 'PASSENGER',
      rect: { x: 0, y: 0, w: 10, h: 12 },
    }),
    pooledZone('LIBRE', 'Zona libre', 'FREE_ZONE', 'PASSENGER', { x: 0, y: 12, w: 10, h: 8 }, [
      { dimension: 'PERSONS', value: 30 },
    ]),
    pooledZone('CARGA', 'Cubierta de carga', 'CARGO_DECK', 'CARGO', { x: 0, y: 20, w: 10, h: 12 }, [
      { dimension: 'WEIGHT_KG', value: 5000 },
      { dimension: 'LINEAR_M', value: 10 },
    ]),
    pooledZone(
      'BODEGA',
      'Bodega',
      'HOLD',
      'PARCEL',
      { x: 0, y: 0, w: 10, h: 20 },
      [
        { dimension: 'WEIGHT_KG', value: 2000 },
        { dimension: 'VOLUME_M3', value: 10 },
      ],
      1,
    ),
  ],
};
export const lancha: LayoutDocument = {
  ...lanchaFloors,
  // Tres camarotes de 2 camas (1 × 2 m cada una): dos lado a lado y el tercero detrás.
  elements: (
    [
      [0, 0],
      [4, 0],
      [0, 4],
    ] as const
  ).flatMap(([x, y], i) => cabin({ cellCm: 50, code: `C${i + 1}`, zoneCode: 'CAMAROTES', x, y, beds: 2 })),
  totalPersons: 36,
};

// --- El bus de dos pisos (12 × 3 m cada uno; filas 2 + 2 con pasillo de 1 m) y la bodega de equipaje debajo -------
//   Piso 1: 4 filas (1A–4D, 16 asientos). Piso 2: 10 filas (5A–14D, 40 asientos). La bodega va como su propio piso,
//   como en el editor («hasta 6 pisos, bodega incluida»).
export const busFloors: LayoutDocument = {
  ...emptyLayout('LAND'),
  decks: [
    { index: 0, name: 'Piso 1', lengthM: 12, widthM: 3 },
    { index: 1, name: 'Piso 2', lengthM: 12, widthM: 3 },
    { index: 2, name: 'Bodega', lengthM: 12, widthM: 3 },
  ],
  zones: [
    zone({
      code: 'PASAJEROS',
      name: 'Pasajeros',
      kind: 'SEATING',
      service: 'PASSENGER',
      rect: { x: 0, y: 0, w: 6, h: 8 },
    }),
    zone({
      code: 'PASAJEROS2',
      name: 'Pasajeros 2',
      kind: 'SEATING',
      service: 'PASSENGER',
      deck: 1,
      rect: { x: 0, y: 0, w: 6, h: 20 },
    }),
    pooledZone(
      'EQUIPAJE',
      'Bodega de equipaje',
      'LUGGAGE',
      'PASSENGER',
      { x: 0, y: 0, w: 6, h: 12 },
      [
        { dimension: 'WEIGHT_KG', value: 1500 },
        { dimension: 'VOLUME_M3', value: 8 },
      ],
      2,
    ),
  ],
};
export const bus: LayoutDocument = {
  ...busFloors,
  elements: [
    ...seatRows({ cellCm: 50, zoneCode: 'PASAJEROS', x: 0, y: 0, rows: 4, layout: [2, 2] }),
    ...seatRows({
      cellCm: 50,
      zoneCode: 'PASAJEROS2',
      deck: 1,
      x: 0,
      y: 0,
      rows: 10,
      layout: [2, 2],
      firstRow: 5,
    }),
  ],
  totalPersons: 56,
};

// --- La camioneta pickup 4×4 de la selva: 5,5 × 2 m con celdas de 25 cm ----------------------------------------------
//   Cabina con 4 asientos (copiloto y 3 atrás) que se venden más caros (CABINA). La tolva, detrás: un tramo con
//   pasajeros por cantidad, más barato (TOLVA), y otro con la carga. Una zona mide personas o carga, no las dos.
export const pickupFloors: LayoutDocument = {
  ...emptyLayout('LAND', 25),
  decks: [{ index: 0, name: 'Piso 1', lengthM: 5.5, widthM: 2 }],
  zones: [
    zone({
      code: 'CABINA',
      name: 'Cabina',
      kind: 'SEATING',
      service: 'PASSENGER',
      rect: { x: 0, y: 0, w: 8, h: 14 },
    }),
    {
      ...pooledZone('TOLVA', 'Tolva · pasajeros', 'FREE_ZONE', 'PASSENGER', { x: 0, y: 14, w: 8, h: 4 }, [
        { dimension: 'PERSONS', value: 4 },
      ]),
      priceClassCode: 'TOLVA',
    },
    pooledZone('CARGA', 'Tolva · carga', 'CARGO_DECK', 'CARGO', { x: 0, y: 18, w: 8, h: 4 }, [
      { dimension: 'WEIGHT_KG', value: 600 },
    ]),
  ],
};
export const pickup: LayoutDocument = {
  ...pickupFloors,
  elements: (
    [
      ['S1', 6, 2],
      ['S2', 0, 8],
      ['S3', 3, 8],
      ['S4', 6, 8],
    ] as const
  ).map(([code, x, y]) => ({
    ...seat({ cellCm: 25, code, zoneCode: 'CABINA', x, y }),
    priceClassCode: 'CABINA',
  })),
  totalPersons: 8,
};
