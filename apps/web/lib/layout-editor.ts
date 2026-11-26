import {
  GENERATOR_SIZES,
  LAYOUT_LIMITS,
  ZONE_RULES,
  bed as bedOf,
  cabin as cabinOf,
  cells,
  deckGrid,
  seat as seatOf,
  seatRowWidth,
  seatRows as seatRowsOf,
  type CapacityDimension,
  type LayoutDocument,
  type LayoutElement,
  type LayoutZone,
  type Rect,
  type TransportService,
  type ZoneKind,
} from '@yebo/contracts';

/**
 * Operaciones del editor de planos (Fase 6.4c, maqueta aprobada): funciones puras sobre el documento del borrador.
 * Cada una devuelve el documento nuevo y un mensaje para anunciar (lector de pantalla y aviso). Las reglas para
 * publicar son las de `validateLayout`; aquí solo se evita lo que el editor nunca debe hacer (salir del piso).
 */

export type Result = { doc: LayoutDocument; message: string; select?: Selection };
export type Selection = { type: 'element'; code: string } | { type: 'zone'; code: string } | { type: 'none' };

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const rectOf = (e: { x: number; y: number; w: number; h: number }): Rect => ({
  x: e.x,
  y: e.y,
  w: e.w,
  h: e.h,
});
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function grid(doc: LayoutDocument, deck: number) {
  const d = doc.decks[deck];
  return d ? deckGrid(doc, d) : { cols: 0, rows: 0 };
}

/** Metros que ocupan `n` celdas, con el separador decimal de es-PE (punto, como el resto del panel): «2.5 m». */
export const meters = (n: number, cellCm: number) =>
  `${((n * cellCm) / 100).toLocaleString('es-PE', { maximumFractionDigits: 2 })} m`;

/** Zonas donde se colocan asientos, camarotes y camas (zonas de pasajeros con elementos, mezclados). */
export const passengerZones = (doc: LayoutDocument, deck: number) =>
  doc.zones.filter(
    (z) =>
      z.deck === deck &&
      ZONE_RULES[z.kind].mode === 'ASSIGNED' &&
      ZONE_RULES[z.kind].elements.includes('SEAT'),
  );

/** Primer hueco libre de `w × h` celdas dentro de la zona (sin pisar elementos, salvo camas sobre su camarote). */
export function findSpot(doc: LayoutDocument, zone: LayoutZone, w: number, h: number) {
  const taken = doc.elements
    .filter((e) => e.deck === zone.deck && e.kind !== 'LABEL' && !e.parentCode)
    .map(rectOf);
  for (let y = zone.rect.y; y + h <= zone.rect.y + zone.rect.h; y++) {
    for (let x = zone.rect.x; x + w <= zone.rect.x + zone.rect.w; x++) {
      const r = { x, y, w, h };
      if (!taken.some((t) => overlaps(t, r))) return { x, y, inside: true };
    }
  }
  return { x: zone.rect.x, y: zone.rect.y, inside: false };
}

const nextNumber = (doc: LayoutDocument, re: RegExp) =>
  Math.max(0, ...doc.elements.map((e) => re.exec(e.code)).map((m) => (m ? Number(m[1]) : 0))) + 1;

const where = (x: number, y: number) => `columna ${x + 1}, fila ${y + 1}`;

/** Filas de asientos `left + right` centradas en la zona, debajo de las que ya hay; la numeración continúa. */
export function addSeatRows(
  doc: LayoutDocument,
  zone: LayoutZone,
  layout: readonly [number, number],
  rows: number,
): Result {
  const width = seatRowWidth(doc.cellCm, layout);
  const pitch = cells(GENERATOR_SIZES.rowPitchM, doc.cellCm);
  const x = zone.rect.x + Math.max(0, Math.floor((zone.rect.w - width) / 2));
  const inZone = doc.elements.filter((e) => e.zoneCode === zone.code && e.kind !== 'LABEL');
  const y = inZone.length
    ? Math.max(...inZone.map((e) => e.y + e.h)) + (pitch - cells(GENERATOR_SIZES.seatM, doc.cellCm))
    : zone.rect.y;
  const firstRow = nextNumber(doc, /^(\d+)[A-Z]$/);
  const added = seatRowsOf({
    cellCm: doc.cellCm,
    zoneCode: zone.code,
    deck: zone.deck,
    x,
    y,
    rows,
    layout,
    firstRow,
  });
  const outside = added.some(
    (e) => e.y + e.h > zone.rect.y + zone.rect.h || e.x + e.w > zone.rect.x + zone.rect.w,
  );
  return {
    doc: { ...doc, elements: [...doc.elements, ...added] },
    select: { type: 'element', code: added[0]!.code },
    message:
      `${added.length} asientos en ${rows} ${rows === 1 ? 'fila' : 'filas'} ${layout[0]} + ${layout[1]} (filas ${firstRow} a ${firstRow + rows - 1})` +
      (outside ? '; algunos no caben en la zona: alárgala o quita filas' : ''),
  };
}

export function addSeat(doc: LayoutDocument, zone: LayoutZone): Result {
  const code = `S${nextNumber(doc, /^S(\d+)$/)}`;
  const size = cells(GENERATOR_SIZES.seatM, doc.cellCm);
  const at = findSpot(doc, zone, size, size);
  const el = seatOf({ cellCm: doc.cellCm, code, zoneCode: zone.code, deck: zone.deck, x: at.x, y: at.y });
  return {
    doc: { ...doc, elements: [...doc.elements, el] },
    select: { type: 'element', code },
    message: at.inside
      ? `Asiento ${code} en la ${where(at.x, at.y)}`
      : `Asiento ${code} añadido, pero la zona no tiene hueco libre`,
  };
}

export function addCabin(doc: LayoutDocument, zone: LayoutZone, beds: number): Result {
  const code = `C${nextNumber(doc, /^C(\d+)$/)}`;
  const at = findSpot(
    doc,
    zone,
    beds * cells(GENERATOR_SIZES.bedWidthM, doc.cellCm),
    cells(GENERATOR_SIZES.bedLengthM, doc.cellCm),
  );
  const added = cabinOf({
    cellCm: doc.cellCm,
    code,
    zoneCode: zone.code,
    deck: zone.deck,
    x: at.x,
    y: at.y,
    beds,
  });
  return {
    doc: { ...doc, elements: [...doc.elements, ...added] },
    select: { type: 'element', code },
    message: at.inside
      ? `Camarote ${code} de ${beds} ${beds === 1 ? 'cama' : 'camas'} en la ${where(at.x, at.y)}`
      : `Camarote ${code} añadido, pero la zona no tiene hueco libre`,
  };
}

export function addBed(doc: LayoutDocument, zone: LayoutZone): Result {
  const code = `K${nextNumber(doc, /^K(\d+)$/)}`;
  const at = findSpot(
    doc,
    zone,
    cells(GENERATOR_SIZES.bedWidthM, doc.cellCm),
    cells(GENERATOR_SIZES.bedLengthM, doc.cellCm),
  );
  const el = bedOf({ cellCm: doc.cellCm, code, zoneCode: zone.code, deck: zone.deck, x: at.x, y: at.y });
  return {
    doc: { ...doc, elements: [...doc.elements, el] },
    select: { type: 'element', code },
    message: at.inside
      ? `Cama suelta ${code} en la ${where(at.x, at.y)}`
      : `Cama ${code} añadida, pero la zona no tiene hueco libre`,
  };
}

/** Tipos de zona que se crean desde el editor, con su nombre, servicio y capacidad inicial. */
export const NEW_ZONE_KINDS: Record<
  Extract<
    ZoneKind,
    'SEATING' | 'VIP' | 'CABINS' | 'FREE_ZONE' | 'HAMMOCK' | 'LUGGAGE' | 'HOLD' | 'CARGO_DECK'
  >,
  { label: string; name: string; prefix: string; service: TransportService; capacity: LayoutZone['capacity'] }
> = {
  SEATING: {
    label: 'Pasajeros: asientos y camarotes',
    name: 'Pasajeros',
    prefix: 'PASAJEROS',
    service: 'PASSENGER',
    capacity: [],
  },
  VIP: { label: 'Pasajeros VIP', name: 'VIP', prefix: 'VIP', service: 'PASSENGER', capacity: [] },
  CABINS: {
    label: 'Pasajeros: camarotes y camas',
    name: 'Camarotes',
    prefix: 'CAMAROTES',
    service: 'PASSENGER',
    capacity: [],
  },
  FREE_ZONE: {
    label: 'Zona libre',
    name: 'Zona libre',
    prefix: 'LIBRE',
    service: 'PASSENGER',
    capacity: [{ dimension: 'PERSONS', value: 20 }],
  },
  HAMMOCK: {
    label: 'Hamacas',
    name: 'Hamacas',
    prefix: 'HAMACAS',
    service: 'PASSENGER',
    capacity: [{ dimension: 'PERSONS', value: 20 }],
  },
  LUGGAGE: {
    label: 'Equipaje',
    name: 'Equipaje',
    prefix: 'EQUIPAJE',
    service: 'PASSENGER',
    capacity: [{ dimension: 'WEIGHT_KG', value: 500 }],
  },
  HOLD: {
    label: 'Bodega',
    name: 'Bodega',
    prefix: 'BODEGA',
    service: 'PARCEL',
    capacity: [
      { dimension: 'WEIGHT_KG', value: 2000 },
      { dimension: 'VOLUME_M3', value: 10 },
    ],
  },
  CARGO_DECK: {
    label: 'Cubierta de carga',
    name: 'Cubierta de carga',
    prefix: 'CARGA',
    service: 'CARGO',
    capacity: [
      { dimension: 'WEIGHT_KG', value: 5000 },
      { dimension: 'LINEAR_M', value: 10 },
    ],
  },
};
export type NewZoneKind = keyof typeof NEW_ZONE_KINDS;

/** Zona nueva a todo el ancho del piso, en el primer tramo libre de `lengthM` metros. */
export function addZone(doc: LayoutDocument, deck: number, kind: NewZoneKind, lengthM: number): Result {
  const spec = NEW_ZONE_KINDS[kind];
  const g = grid(doc, deck);
  const h = clamp(cells(lengthM, doc.cellCm), 2, Math.max(2, g.rows));
  const taken = doc.zones.filter((z) => z.deck === deck);
  let y: number | null = null;
  for (let cy = 0; cy + h <= g.rows && y === null; cy++) {
    if (!taken.some((z) => cy < z.rect.y + z.rect.h && z.rect.y < cy + h)) y = cy;
  }
  let n = 1;
  while (doc.zones.some((z) => z.code === `${spec.prefix}${n}`)) n++;
  const sameName = doc.zones.filter((z) => z.name.startsWith(spec.name)).length;
  const zone: LayoutZone = {
    code: `${spec.prefix}${n}`,
    name: sameName ? `${spec.name} ${sameName + 1}` : spec.name,
    kind,
    service: spec.service,
    deck,
    rect: { x: 0, y: y ?? 0, w: g.cols, h },
    priceClassCode: null,
    capacity: spec.capacity.map((c) => ({ ...c })),
    constraints: null,
  };
  const deckName = doc.decks[deck]?.name ?? '';
  return {
    doc: { ...doc, zones: [...doc.zones, zone] },
    select: { type: 'zone', code: zone.code },
    message:
      y === null
        ? `${zone.name} creada, pero se solapa con otras zonas: ${deckName} no tiene un tramo libre de ${meters(h, doc.cellCm)}`
        : `${zone.name} creada en ${deckName}, de la fila ${y + 1} a la ${y + h}`,
  };
}

/** Mueve o redimensiona una zona sin salir del piso (los controles se detienen en el borde; mínimo 2 celdas). */
export function reshapeZone(doc: LayoutDocument, code: string, f: (r: Rect) => Rect): Result {
  const zone = doc.zones.find((z) => z.code === code);
  if (!zone) return { doc, message: '' };
  const g = grid(doc, zone.deck);
  const n = f(zone.rect);
  const w = clamp(n.w, 2, g.cols);
  const h = clamp(n.h, 2, g.rows);
  const rect = { w, h, x: clamp(n.x, 0, g.cols - w), y: clamp(n.y, 0, g.rows - h) };
  return {
    doc: { ...doc, zones: doc.zones.map((z) => (z.code === code ? { ...z, rect } : z)) },
    message: `${zone.name}: ${meters(w, doc.cellCm)} de ancho por ${meters(h, doc.cellCm)} de largo, desde la ${where(rect.x, rect.y)}`,
  };
}

/** Mueve un elemento (y las camas de un camarote) sin salir del piso. */
export function moveElement(doc: LayoutDocument, code: string, dx: number, dy: number): Result {
  const el = doc.elements.find((e) => e.code === code);
  if (!el) return { doc, message: '' };
  const g = grid(doc, el.deck);
  const nx = clamp(el.x + dx, 0, g.cols - el.w);
  const ny = clamp(el.y + dy, 0, g.rows - el.h);
  const mx = nx - el.x;
  const my = ny - el.y;
  return {
    doc: {
      ...doc,
      elements: doc.elements.map((e) =>
        e.code === code || e.parentCode === code ? { ...e, x: e.x + mx, y: e.y + my } : e,
      ),
    },
    message: mx === 0 && my === 0 ? `${code} ya está en el borde del piso` : `${code} en la ${where(nx, ny)}`,
  };
}

/** Quita un elemento; un camarote se lleva sus camas. Una cama de camarote ajusta la capacidad del camarote. */
export function removeElement(doc: LayoutDocument, code: string): Result {
  const el = doc.elements.find((e) => e.code === code);
  if (!el) return { doc, message: '' };
  const kids = doc.elements.filter((e) => e.parentCode === code).length;
  let elements = doc.elements.filter((e) => e.code !== code && e.parentCode !== code);
  if (el.kind === 'BED' && el.parentCode) elements = syncCabin(elements, el.parentCode);
  return {
    doc: { ...doc, elements },
    select: { type: 'none' },
    message: kids ? `Se quitó ${code} y sus ${kids} camas` : `Se quitó ${code}`,
  };
}

/** La capacidad de un camarote con camas es la suma de sus camas; sin camas, deja de venderse «completo». */
export function syncCabin(elements: LayoutElement[], cabinCode: string): LayoutElement[] {
  const beds = elements.filter((e) => e.parentCode === cabinCode);
  return elements.map((e) =>
    e.code !== cabinCode
      ? e
      : beds.length
        ? { ...e, capacity: beds.reduce((s, b) => s + b.capacity, 0) }
        : { ...e, sellableAsUnit: false },
  );
}

export function updateElement(
  doc: LayoutDocument,
  code: string,
  patch: Partial<LayoutElement>,
): LayoutDocument {
  let elements = doc.elements.map((e) => (e.code === code ? { ...e, ...patch } : e));
  const el = elements.find((e) => e.code === code);
  if (el?.kind === 'BED' && el.parentCode) elements = syncCabin(elements, el.parentCode);
  return { ...doc, elements };
}

export function updateZone(doc: LayoutDocument, code: string, patch: Partial<LayoutZone>): LayoutDocument {
  return { ...doc, zones: doc.zones.map((z) => (z.code === code ? { ...z, ...patch } : z)) };
}

/** Fija (o quita, con `null`) una dimensión de capacidad de una zona. */
export function setZoneCapacity(
  doc: LayoutDocument,
  code: string,
  dimension: CapacityDimension,
  value: number | null,
): LayoutDocument {
  return {
    ...doc,
    zones: doc.zones.map((z) => {
      if (z.code !== code) return z;
      const rest = z.capacity.filter((c) => c.dimension !== dimension);
      const capacity = value === null || !(value > 0) ? rest : [...rest, { dimension, value }];
      const order = ZONE_RULES[z.kind].dimensions;
      return {
        ...z,
        capacity: capacity.sort((a, b) => order.indexOf(a.dimension) - order.indexOf(b.dimension)),
      };
    }),
  };
}

/** Un piso nuevo al final (antes no hay límite de orden: la bodega puede ser cualquiera). */
export function addDeck(doc: LayoutDocument): Result {
  if (doc.decks.length >= LAYOUT_LIMITS.decks) {
    return { doc, message: `Un plano tiene como mucho ${LAYOUT_LIMITS.decks} pisos` };
  }
  const index = doc.decks.length;
  const base = doc.decks[doc.decks.length - 1] ?? doc.decks[0];
  const deck = { index, name: `Piso ${index + 1}`, lengthM: base?.lengthM ?? 10, widthM: base?.widthM ?? 4 };
  return {
    doc: { ...doc, decks: [...doc.decks, deck] },
    select: { type: 'none' },
    message: `${deck.name} añadido con ${deck.lengthM} × ${deck.widthM} m: ajusta su largo y su ancho`,
  };
}

/** Quita un piso vacío y renumera los siguientes (y sus zonas y elementos): las cubiertas van 0, 1, 2… */
export function removeDeck(doc: LayoutDocument, index: number): Result {
  const deck = doc.decks[index];
  if (!deck) return { doc, message: '' };
  if (doc.decks.length === 1) return { doc, message: 'Un plano necesita al menos un piso' };
  if (doc.zones.some((z) => z.deck === index) || doc.elements.some((e) => e.deck === index)) {
    return { doc, message: `Solo se quita un piso vacío: ${deck.name} tiene zonas o elementos` };
  }
  const shift = (d: number) => (d > index ? d - 1 : d);
  return {
    doc: {
      ...doc,
      decks: doc.decks.filter((d) => d.index !== index).map((d, i) => ({ ...d, index: i })),
      zones: doc.zones.map((z) => ({ ...z, deck: shift(z.deck) })),
      elements: doc.elements.map((e) => ({ ...e, deck: shift(e.deck) })),
    },
    select: { type: 'none' },
    message: `${deck.name} quitado`,
  };
}

/** De un problema de `validateLayout` (`elements.12`, `zones.3.rect`…) a lo que hay que seleccionar. */
export function issueTarget(doc: LayoutDocument, path: string): { deck: number; select: Selection } | null {
  const m = /^(elements|zones|decks)\.(\d+)/.exec(path);
  if (!m) return null;
  const i = Number(m[2]);
  if (m[1] === 'elements') {
    const e = doc.elements[i];
    return e ? { deck: e.deck, select: { type: 'element', code: e.code } } : null;
  }
  if (m[1] === 'zones') {
    const z = doc.zones[i];
    return z ? { deck: z.deck, select: { type: 'zone', code: z.code } } : null;
  }
  return { deck: i, select: { type: 'none' } };
}

/** El elemento más cercano en una dirección (para recorrer el plano con las flechas). */
export function nearest(
  list: LayoutElement[],
  from: LayoutElement,
  dir: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight',
): LayoutElement | null {
  let best: LayoutElement | null = null;
  let bestScore = Infinity;
  for (const e of list) {
    if (e.code === from.code) continue;
    const dx = e.x - from.x;
    const dy = e.y - from.y;
    const ok = { ArrowRight: dx > 0, ArrowLeft: dx < 0, ArrowDown: dy > 0, ArrowUp: dy < 0 }[dir];
    if (!ok) continue;
    const horizontal = dir === 'ArrowLeft' || dir === 'ArrowRight';
    const score = horizontal ? Math.abs(dx) + Math.abs(dy) * 3 : Math.abs(dy) + Math.abs(dx) * 3;
    const s = score + (e.parentCode ? 0.5 : 0);
    if (s < bestScore) {
      best = e;
      bestScore = s;
    }
  }
  return best;
}
