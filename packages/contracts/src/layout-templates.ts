import {
  LAYOUT_SCHEMA_VERSION,
  type LayoutDocument,
  type LayoutElement,
  type LayoutZone,
  type Rect,
  type ZoneKind,
} from './layouts';

/**
 * Generadores y plantillas de inicio de los layouts (F6-Q1). Funciones puras: el editor (6.4) las usa para crear
 * elementos en la grilla, y la empresa copia una plantilla y la ajusta. Todo lo que generan cumple validateLayout.
 */

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

/**
 * Filas de asientos con pasillo: `layout` es cuántos asientos hay a cada lado del pasillo (p. ej., [2, 2] o [2, 1]).
 * Los códigos son número de fila + letra (1A, 1B, 1C…), en orden de izquierda a derecha.
 */
export function seatRows(opts: {
  zoneCode: string;
  deck?: number;
  x: number;
  y: number;
  rows: number;
  layout: readonly [number, number];
  firstRow?: number;
}): LayoutElement[] {
  const [left, right] = opts.layout;
  const out: LayoutElement[] = [];
  for (let r = 0; r < opts.rows; r++) {
    const row = (opts.firstRow ?? 1) + r;
    let letter = 0;
    for (let c = 0; c < left + right; c++) {
      const col = c < left ? c : c + 1; // una columna de pasillo en medio
      out.push(
        element({
          code: `${row}${String.fromCharCode(65 + letter++)}`,
          kind: 'SEAT',
          zoneCode: opts.zoneCode,
          deck: opts.deck ?? 0,
          x: opts.x + col,
          y: opts.y + r,
        }),
      );
    }
  }
  return out;
}

/** Camarote de `beds` camas (de 1 o 2 personas) en una fila, con su código (C1) y las camas C1-B1, C1-B2… */
export function cabin(opts: {
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
  const parent = element({
    code: opts.code,
    kind: 'CABIN',
    zoneCode: opts.zoneCode,
    deck,
    x: opts.x,
    y: opts.y,
    w: opts.beds,
    h: 2,
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
      x: opts.x + i,
      y: opts.y,
      h: 2,
      capacity: bedCapacity,
    }),
  );
  return [parent, ...beds];
}

/** Rectángulo de una zona con su tipo, para los generadores de zonas por cantidad. */
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

/** Bus de 40 asientos (2+2 × 10 filas) con bodega de equipaje. */
export function busTemplate(): LayoutDocument {
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    decks: [{ index: 0, name: 'Piso 1', width: 5, height: 14 }],
    zones: [
      zone({
        code: 'SALON',
        name: 'Salón',
        kind: 'SEATING',
        service: 'PASSENGER',
        rect: { x: 0, y: 1, w: 5, h: 10 },
      }),
      pooledZone('BODEGA', 'Bodega', 'LUGGAGE', 'PASSENGER', { x: 0, y: 11, w: 5, h: 3 }, [
        { dimension: 'WEIGHT_KG', value: 1500 },
        { dimension: 'VOLUME_M3', value: 8 },
      ]),
    ],
    elements: [
      element({ code: 'PUERTA', kind: 'DOOR', x: 4, y: 0 }),
      element({ code: 'CHOFER', kind: 'OTHER', x: 0, y: 0, label: 'Conductor' }),
      ...seatRows({ zoneCode: 'SALON', x: 0, y: 1, rows: 10, layout: [2, 2] }),
    ],
    totalPersons: 40,
  };
}

/** Lancha con camarotes (con camas), zona libre, bodega y cubierta de carga. */
export function boatTemplate(): LayoutDocument {
  const cabins = [0, 1, 2, 3].flatMap((i) =>
    cabin({ code: `C${i + 1}`, zoneCode: 'CAMAROTES', x: i * 2, y: 1, beds: 2 }),
  );
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    decks: [
      { index: 0, name: 'Cubierta principal', width: 10, height: 16 },
      { index: 1, name: 'Bodega', width: 10, height: 8 },
    ],
    zones: [
      zone({
        code: 'CAMAROTES',
        name: 'Camarotes',
        kind: 'CABINS',
        service: 'PASSENGER',
        rect: { x: 0, y: 1, w: 8, h: 2 },
      }),
      pooledZone('LIBRE', 'Zona libre', 'FREE_ZONE', 'PASSENGER', { x: 0, y: 4, w: 10, h: 7 }, [
        { dimension: 'PERSONS', value: 60 },
      ]),
      pooledZone('CUBIERTA', 'Cubierta de carga', 'CARGO_DECK', 'CARGO', { x: 0, y: 12, w: 10, h: 4 }, [
        { dimension: 'WEIGHT_KG', value: 20000 },
        { dimension: 'LINEAR_M', value: 30 },
      ]),
      pooledZone(
        'BODEGA',
        'Bodega',
        'HOLD',
        'PARCEL',
        { x: 0, y: 0, w: 10, h: 8 },
        [
          { dimension: 'WEIGHT_KG', value: 8000 },
          { dimension: 'VOLUME_M3', value: 40 },
        ],
        1,
      ),
    ],
    elements: [element({ code: 'PROA', kind: 'LABEL', x: 0, y: 0, w: 10, label: 'Proa' }), ...cabins],
    totalPersons: 70,
  };
}
