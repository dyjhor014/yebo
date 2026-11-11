import {
  LAYOUT_SCHEMA_VERSION,
  cells,
  type LayoutDocument,
  type LayoutElement,
  type LayoutZone,
  type Rect,
  type ZoneKind,
} from './layouts';

/**
 * Generadores y plantillas de inicio de los planos (F6-Q1; Fase 6.4: a escala real). Funciones puras: el editor las
 * usa para crear elementos en la grilla, y la empresa copia una plantilla y la ajusta. Las medidas son reales y se
 * convierten a celdas con la escala del plano (`cellCm`): un asiento mide 0,5 m y cada fila ocupa 1 m; una cama mide
 * 1 × 2 m. Todo lo que generan cumple validateLayout si cabe en su zona.
 */

type Scale = 25 | 50;

const element = (
  over: Partial<LayoutElement> & Pick<LayoutElement, 'code' | 'kind' | 'x' | 'y'>,
): LayoutElement => ({
  zoneCode: null,
  parentCode: null,
  deck: 0,
  w: 1,
  h: 1,
  rotation: 0,
  capacity: 1,
  priceClassCode: null,
  sellableAsUnit: false,
  label: null,
  ...over,
});

export function zone(
  over: Pick<LayoutZone, 'code' | 'name' | 'kind' | 'service' | 'rect'> & Partial<LayoutZone>,
): LayoutZone {
  return { deck: 0, priceClassCode: null, capacity: [], constraints: null, ...over };
}

/** Medidas de los generadores, en metros. */
export const GENERATOR_SIZES = { seatM: 0.5, rowPitchM: 1, bedWidthM: 1, bedLengthM: 2 } as const;

/** Ancho total de una fila (asientos y pasillo), en celdas: para centrarla en su zona. */
export function seatRowWidth(cellCm: Scale, layout: readonly [number, number], aisleM = 1): number {
  return (layout[0] + layout[1]) * cells(GENERATOR_SIZES.seatM, cellCm) + cells(aisleM, cellCm);
}

/**
 * Filas de asientos con pasillo (Fase 6.4): `layout` es cuántos asientos hay a cada lado del pasillo, 2 o 3
 * (2+2, 3+3, 2+3, 3+2). Códigos: número de fila + letra (1A, 1B…), de izquierda a derecha; `firstRow` continúa la
 * numeración del plano. Se pueden encadenar llamadas con distinto `layout` para mezclar filas en el mismo piso.
 */
export function seatRows(opts: {
  cellCm: Scale;
  zoneCode: string;
  deck?: number;
  x: number;
  y: number;
  rows: number;
  layout: readonly [number, number];
  aisleM?: number;
  firstRow?: number;
}): LayoutElement[] {
  const [left, right] = opts.layout;
  const seat = cells(GENERATOR_SIZES.seatM, opts.cellCm);
  const pitch = cells(GENERATOR_SIZES.rowPitchM, opts.cellCm);
  const aisle = cells(opts.aisleM ?? 1, opts.cellCm);
  const out: LayoutElement[] = [];
  for (let r = 0; r < opts.rows; r++) {
    const row = (opts.firstRow ?? 1) + r;
    for (let k = 0; k < left + right; k++) {
      const x = k < left ? opts.x + k * seat : opts.x + left * seat + aisle + (k - left) * seat;
      out.push(
        element({
          code: `${row}${String.fromCharCode(65 + k)}`,
          kind: 'SEAT',
          zoneCode: opts.zoneCode,
          deck: opts.deck ?? 0,
          x,
          y: opts.y + r * pitch,
          w: seat,
          h: seat,
        }),
      );
    }
  }
  return out;
}

/** Un asiento individual de 0,5 × 0,5 m. */
export function seat(opts: {
  cellCm: Scale;
  code: string;
  zoneCode: string;
  deck?: number;
  x: number;
  y: number;
}) {
  const size = cells(GENERATOR_SIZES.seatM, opts.cellCm);
  return element({
    code: opts.code,
    kind: 'SEAT',
    zoneCode: opts.zoneCode,
    deck: opts.deck ?? 0,
    x: opts.x,
    y: opts.y,
    w: size,
    h: size,
  });
}

/** Camarote de 1 a 4 camas de 1 × 2 m en fila, con su código (C1) y las camas C1-B1, C1-B2… */
export function cabin(opts: {
  cellCm: Scale;
  code: string;
  zoneCode: string;
  deck?: number;
  x: number;
  y: number;
  beds: number;
  bedCapacity?: 1 | 2;
  sellableAsUnit?: boolean;
}): LayoutElement[] {
  const bedCapacity = opts.bedCapacity ?? 1;
  const deck = opts.deck ?? 0;
  const bw = cells(GENERATOR_SIZES.bedWidthM, opts.cellCm);
  const bh = cells(GENERATOR_SIZES.bedLengthM, opts.cellCm);
  const parent = element({
    code: opts.code,
    kind: 'CABIN',
    zoneCode: opts.zoneCode,
    deck,
    x: opts.x,
    y: opts.y,
    w: opts.beds * bw,
    h: bh,
    capacity: opts.beds * bedCapacity,
    sellableAsUnit: opts.sellableAsUnit ?? true,
  });
  const beds = Array.from({ length: opts.beds }, (_, i) =>
    element({
      code: `${opts.code}-B${i + 1}`,
      kind: 'BED',
      zoneCode: opts.zoneCode,
      parentCode: opts.code,
      deck,
      x: opts.x + i * bw,
      y: opts.y,
      w: bw,
      h: bh,
      capacity: bedCapacity,
    }),
  );
  return [parent, ...beds];
}

/** Cama suelta de 1 × 2 m (sin camarote): se vende sola. */
export function bed(opts: {
  cellCm: Scale;
  code: string;
  zoneCode: string;
  deck?: number;
  x: number;
  y: number;
  capacity?: 1 | 2;
}): LayoutElement {
  return element({
    code: opts.code,
    kind: 'BED',
    zoneCode: opts.zoneCode,
    deck: opts.deck ?? 0,
    x: opts.x,
    y: opts.y,
    w: cells(GENERATOR_SIZES.bedWidthM, opts.cellCm),
    h: cells(GENERATOR_SIZES.bedLengthM, opts.cellCm),
    capacity: opts.capacity ?? 1,
  });
}

/** Zona por cantidad (zona libre, hamacas, bodega, cubierta…). */
export function pooledZone(
  code: string,
  name: string,
  kind: Extract<ZoneKind, 'FREE_ZONE' | 'HAMMOCK' | 'LUGGAGE' | 'HOLD' | 'CARGO_DECK'>,
  service: LayoutZone['service'],
  rect: Rect,
  capacity: LayoutZone['capacity'],
  deck = 0,
): LayoutZone {
  return zone({ code, name, kind, service, rect, capacity, deck });
}

/** Bus de 40 asientos (2+2 × 10 filas, pasillo de 0,5 m) y bodega de equipaje trasera. 12 × 2,5 m a 50 cm. */
export function busTemplate(): LayoutDocument {
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    cellCm: 50,
    decks: [{ index: 0, name: 'Piso 1', lengthM: 12, widthM: 2.5 }],
    zones: [
      zone({
        code: 'SALON',
        name: 'Salón',
        kind: 'SEATING',
        service: 'PASSENGER',
        rect: { x: 0, y: 2, w: 5, h: 20 },
      }),
      pooledZone('BODEGA', 'Bodega de equipaje', 'LUGGAGE', 'PASSENGER', { x: 0, y: 22, w: 5, h: 2 }, [
        { dimension: 'WEIGHT_KG', value: 1500 },
        { dimension: 'VOLUME_M3', value: 8 },
      ]),
    ],
    elements: [
      element({ code: 'CHOFER', kind: 'OTHER', x: 0, y: 0, w: 2, h: 2, label: 'Conductor' }),
      element({ code: 'PUERTA', kind: 'DOOR', x: 4, y: 0 }),
      ...seatRows({ cellCm: 50, zoneCode: 'SALON', x: 0, y: 2, rows: 10, layout: [2, 2], aisleM: 0.5 }),
    ],
    totalPersons: 40,
  };
}

/** Lancha rápida: un piso de 12 × 3 m con 40 asientos 2+2 (pasillo de 1 m) y bodega de equipaje. */
export function fastBoatTemplate(): LayoutDocument {
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    cellCm: 50,
    decks: [{ index: 0, name: 'Piso 1', lengthM: 12, widthM: 3 }],
    zones: [
      zone({
        code: 'ASIENTOS',
        name: 'Asientos',
        kind: 'SEATING',
        service: 'PASSENGER',
        rect: { x: 0, y: 2, w: 6, h: 20 },
      }),
      pooledZone('EQUIPAJE', 'Equipaje', 'LUGGAGE', 'PASSENGER', { x: 0, y: 22, w: 6, h: 2 }, [
        { dimension: 'WEIGHT_KG', value: 800 },
      ]),
    ],
    elements: [
      element({ code: 'PROA', kind: 'LABEL', x: 0, y: 0, w: 6, h: 2, label: 'Proa' }),
      ...seatRows({ cellCm: 50, zoneCode: 'ASIENTOS', x: 0, y: 2, rows: 10, layout: [2, 2] }),
    ],
    totalPersons: 40,
  };
}

/**
 * Lancha de 3 pisos y bodega (la de la maqueta aprobada): piso 1 con 4 camarotes de 2 camas, zona libre y cubierta de
 * carga; piso 2 con 36 asientos 3+3; piso 3 con una terraza libre; bodega de encomiendas. Escala de 50 cm.
 */
export function boatTemplate(): LayoutDocument {
  const cabins = (
    [
      [0, 2],
      [6, 2],
      [0, 7],
      [6, 7],
    ] as const
  ).flatMap(([x, y], i) => cabin({ cellCm: 50, code: `C${i + 1}`, zoneCode: 'CAMAROTES', x, y, beds: 2 }));
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    cellCm: 50,
    decks: [
      { index: 0, name: 'Piso 1', lengthM: 16, widthM: 5 },
      { index: 1, name: 'Piso 2', lengthM: 9, widthM: 5 },
      { index: 2, name: 'Piso 3 · terraza', lengthM: 8, widthM: 5 },
      { index: 3, name: 'Bodega', lengthM: 14, widthM: 5 },
    ],
    zones: [
      zone({
        code: 'CAMAROTES',
        name: 'Camarotes',
        kind: 'CABINS',
        service: 'PASSENGER',
        rect: { x: 0, y: 2, w: 10, h: 9 },
      }),
      pooledZone('LIBRE', 'Zona libre', 'FREE_ZONE', 'PASSENGER', { x: 0, y: 12, w: 10, h: 9 }, [
        { dimension: 'PERSONS', value: 40 },
      ]),
      pooledZone('CUBIERTA', 'Cubierta de carga', 'CARGO_DECK', 'CARGO', { x: 0, y: 22, w: 10, h: 10 }, [
        { dimension: 'WEIGHT_KG', value: 12000 },
        { dimension: 'LINEAR_M', value: 20 },
      ]),
      zone({
        code: 'ASIENTOS',
        name: 'Salón de asientos',
        kind: 'SEATING',
        service: 'PASSENGER',
        deck: 1,
        rect: { x: 0, y: 2, w: 10, h: 14 },
      }),
      pooledZone(
        'TERRAZA',
        'Terraza',
        'FREE_ZONE',
        'PASSENGER',
        { x: 0, y: 2, w: 10, h: 12 },
        [{ dimension: 'PERSONS', value: 30 }],
        2,
      ),
      pooledZone(
        'BODEGA',
        'Bodega',
        'HOLD',
        'PARCEL',
        { x: 0, y: 1, w: 10, h: 26 },
        [
          { dimension: 'WEIGHT_KG', value: 8000 },
          { dimension: 'VOLUME_M3', value: 40 },
        ],
        3,
      ),
    ],
    elements: [
      element({ code: 'PROA', kind: 'LABEL', x: 0, y: 0, w: 10, h: 2, label: 'Proa' }),
      ...cabins,
      ...seatRows({ cellCm: 50, zoneCode: 'ASIENTOS', deck: 1, x: 1, y: 3, rows: 6, layout: [3, 3] }),
    ],
    totalPersons: 110,
  };
}
