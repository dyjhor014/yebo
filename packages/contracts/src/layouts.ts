import { z } from 'zod';
import { ModalitySchema } from './fleet';
import { TransportServiceSchema } from './tenants';

/**
 * Fase 6.3 · Layouts de los vehículos (data-dictionary §4; capacity-and-inventory §2–4; auditoría T4: grilla con
 * elementos posicionados, sin dibujo libre).
 *
 * El borrador de una versión es este documento (`LayoutDocument`), que el editor guarda entero. Al publicar, la API
 * comprueba las reglas (`validateLayout`) y lo materializa en zonas, elementos y reglas de capacidad inmutables;
 * `deriveInventory` dice qué inventario tendrá un viaje con esa versión (Fase 7): recursos asignables (asiento, cama,
 * camarote sin camas, espacio de vehículo) y pools de capacidad (zona libre, hamacas, bodega, cubierta, aforo total).
 */

/**
 * v2 (Fase 6.4, aprobada con la maqueta): escala del plano (`cellCm`) y medidas reales de cada piso en metros; la
 * grilla se calcula (`deckGrid`). Hasta 6 pisos. En `yebo_dev` no había layouts v1 que convertir.
 */
export const LAYOUT_SCHEMA_VERSION = 2;

/** Tipos de zona (catálogo de data-dictionary §4, más CABINS para los camarotes). */
export const ZONE_KINDS = [
  'SEATING',
  'VIP',
  'CABINS',
  'FREE_ZONE',
  'HAMMOCK',
  'LUGGAGE',
  'HOLD',
  'CARGO_DECK',
  'VEHICLE_DECK',
] as const;
export const ZoneKindSchema = z.enum(ZONE_KINDS);
export type ZoneKind = z.infer<typeof ZoneKindSchema>;

/** El servicio de una zona es uno de los que opera una empresa (tenant_services). */
export type TransportService = z.infer<typeof TransportServiceSchema>;

export const ALLOCATION_MODES = ['ASSIGNED', 'POOLED'] as const;
export const AllocationModeSchema = z.enum(ALLOCATION_MODES);
export type AllocationMode = z.infer<typeof AllocationModeSchema>;

export const CAPACITY_DIMENSIONS = ['PERSONS', 'UNITS', 'WEIGHT_KG', 'VOLUME_M3', 'LINEAR_M'] as const;
export const CapacityDimensionSchema = z.enum(CAPACITY_DIMENSIONS);
export type CapacityDimension = z.infer<typeof CapacityDimensionSchema>;

export const ELEMENT_KINDS = [
  'SEAT',
  'BED',
  'CABIN',
  'VEHICLE_SLOT',
  'AISLE',
  'STAIRS',
  'DOOR',
  'WC',
  'LABEL',
  'OTHER',
] as const;
export const ElementKindSchema = z.enum(ELEMENT_KINDS);
export type ElementKind = z.infer<typeof ElementKindSchema>;

/** Elementos que forman inventario; el resto es referencia visual (pasillo, escalera, puerta, baño, rótulo…). */
export const INVENTORY_ELEMENT_KINDS: readonly ElementKind[] = ['SEAT', 'BED', 'CABIN', 'VEHICLE_SLOT'];

/**
 * Qué admite cada tipo de zona: modos, servicios, elementos asignables dentro y dimensiones de capacidad. Una zona
 * ASSIGNED vende elementos identificados; una POOLED vende cantidad (capacity-and-inventory §2). La cubierta de
 * vehículos combina espacios (ASSIGNED) con límites de peso y metros lineales (capacity-and-inventory ej. G).
 */
export const ZONE_RULES: Record<
  ZoneKind,
  {
    mode: AllocationMode;
    services: readonly TransportService[];
    elements: readonly ElementKind[];
    dimensions: readonly CapacityDimension[];
    /** POOLED: exige al menos una regla de capacidad. */
    needsCapacity: boolean;
    priceClass: string;
  }
> = {
  // Las zonas de pasajeros con elementos admiten asientos, camarotes y camas mezclados (Fase 6.4). La clase de precio
  // por defecto depende del elemento (deriveInventory): el asiento, la de la zona; la cama, CAMA; el camarote, CAMAROTE.
  SEATING: {
    mode: 'ASSIGNED',
    services: ['PASSENGER'],
    elements: ['SEAT', 'CABIN', 'BED'],
    dimensions: [],
    needsCapacity: false,
    priceClass: 'GENERAL',
  },
  VIP: {
    mode: 'ASSIGNED',
    services: ['PASSENGER'],
    elements: ['SEAT', 'CABIN', 'BED'],
    dimensions: [],
    needsCapacity: false,
    priceClass: 'VIP',
  },
  CABINS: {
    mode: 'ASSIGNED',
    services: ['PASSENGER'],
    elements: ['SEAT', 'CABIN', 'BED'],
    dimensions: [],
    needsCapacity: false,
    priceClass: 'CAMAROTE',
  },
  FREE_ZONE: {
    mode: 'POOLED',
    services: ['PASSENGER'],
    elements: [],
    dimensions: ['PERSONS'],
    needsCapacity: true,
    priceClass: 'GENERAL',
  },
  HAMMOCK: {
    mode: 'POOLED',
    services: ['PASSENGER'],
    elements: [],
    dimensions: ['PERSONS'],
    needsCapacity: true,
    priceClass: 'HAMACA',
  },
  LUGGAGE: {
    mode: 'POOLED',
    services: ['PASSENGER'],
    elements: [],
    dimensions: ['WEIGHT_KG', 'VOLUME_M3', 'UNITS'],
    needsCapacity: true,
    priceClass: 'EQUIPAJE',
  },
  HOLD: {
    mode: 'POOLED',
    services: ['PARCEL', 'CARGO'],
    elements: [],
    dimensions: ['WEIGHT_KG', 'VOLUME_M3', 'UNITS'],
    needsCapacity: true,
    priceClass: 'BODEGA',
  },
  CARGO_DECK: {
    mode: 'POOLED',
    services: ['CARGO'],
    elements: [],
    dimensions: ['WEIGHT_KG', 'VOLUME_M3', 'LINEAR_M'],
    needsCapacity: true,
    priceClass: 'CUBIERTA',
  },
  VEHICLE_DECK: {
    mode: 'ASSIGNED',
    services: ['VEHICLE_TRANSPORT'],
    elements: ['VEHICLE_SLOT'],
    dimensions: ['WEIGHT_KG', 'LINEAR_M'],
    needsCapacity: false,
    priceClass: 'VEHICULO',
  },
};

const Code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,11}$/, 'Usa hasta 12 letras, números o guiones');
const PriceClass = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,23}$/, 'Clase de precio en mayúsculas (p. ej., GENERAL, VIP, CAMA)')
  .nullable();
/**
 * Límites (Fase 6.4): hasta 6 pisos, bodega incluida; cada piso de hasta 30 m de ancho y 100 m de largo. Con celdas de
 * 25 cm, la grilla llega a 120 × 400 celdas.
 */
export const LAYOUT_LIMITS = {
  decks: 6,
  maxWidthM: 30,
  maxLengthM: 100,
  zones: 60,
  elements: 1500,
} as const;
export const CELL_SIZES_CM = [25, 50] as const;
const MAX_CELLS = (LAYOUT_LIMITS.maxLengthM * 100) / CELL_SIZES_CM[0];
const Cell = z
  .number()
  .int()
  .min(0)
  .max(MAX_CELLS - 1);
const Span = z.number().int().min(1).max(MAX_CELLS);
/** Medida en metros, múltiplo de 25 cm (la celda más pequeña). */
const Meters = (max: number) =>
  z
    .number()
    .min(1)
    .max(max)
    .refine((m) => Number.isInteger(m * 4), { message: 'Usa múltiplos de 25 cm (p. ej., 4,25 m)' });

export const LayoutDeckSchema = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .max(LAYOUT_LIMITS.decks - 1),
    name: z.string().trim().min(1).max(40),
    /** Medidas reales del piso (eslora y manga útiles), en metros. */
    lengthM: Meters(LAYOUT_LIMITS.maxLengthM),
    widthM: Meters(LAYOUT_LIMITS.maxWidthM),
  })
  .strict();
export type LayoutDeck = z.infer<typeof LayoutDeckSchema>;

export const RectSchema = z.object({ x: Cell, y: Cell, w: Span, h: Span }).strict();
export type Rect = z.infer<typeof RectSchema>;

export const ZoneConstraintsSchema = z
  .object({
    maxLengthM: z.number().positive().max(40).nullable(),
    maxWidthM: z.number().positive().max(10).nullable(),
    maxHeightM: z.number().positive().max(10).nullable(),
    maxUnitKg: z.number().positive().max(200_000).nullable(),
    /** Exige la aprobación de un rol autorizado (maquinaria pesada; capacity-and-inventory ej. G). */
    manualApproval: z.boolean(),
  })
  .strict();
export type ZoneConstraints = z.infer<typeof ZoneConstraintsSchema>;

export const LayoutZoneSchema = z
  .object({
    code: Code,
    name: z.string().trim().min(1).max(60),
    kind: ZoneKindSchema,
    service: TransportServiceSchema,
    deck: z
      .number()
      .int()
      .min(0)
      .max(LAYOUT_LIMITS.decks - 1),
    rect: RectSchema,
    priceClassCode: PriceClass,
    capacity: z
      .array(
        z
          .object({ dimension: CapacityDimensionSchema, value: z.number().positive().max(10_000_000) })
          .strict(),
      )
      .max(5),
    constraints: ZoneConstraintsSchema.nullable(),
  })
  .strict();
export type LayoutZone = z.infer<typeof LayoutZoneSchema>;

export const LayoutElementSchema = z
  .object({
    code: Code,
    kind: ElementKindSchema,
    zoneCode: Code.nullable(),
    /** Solo las camas: el camarote que las contiene. */
    parentCode: Code.nullable(),
    deck: z
      .number()
      .int()
      .min(0)
      .max(LAYOUT_LIMITS.decks - 1),
    x: Cell,
    y: Cell,
    w: Span,
    h: Span,
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    /** Personas: asiento 1; cama 1 o 2 (compartida); camarote sin camas hasta 12; espacio de vehículo, 1 unidad. */
    capacity: z.number().int().min(1).max(12),
    priceClassCode: PriceClass,
    /** Camarote con camas: se puede vender completo (todas sus camas a la vez; capacity-and-inventory ej. D). */
    sellableAsUnit: z.boolean(),
    label: z.string().trim().max(40).nullable(),
  })
  .strict();
export type LayoutElement = z.infer<typeof LayoutElementSchema>;

export const LayoutDocumentSchema = z
  .object({
    schemaVersion: z.literal(LAYOUT_SCHEMA_VERSION),
    /** Escala de la grilla: cada celda mide 25 o 50 cm. Se elige al crear el plano y no cambia. */
    cellCm: z.union([z.literal(25), z.literal(50)]),
    decks: z.array(LayoutDeckSchema).min(1).max(LAYOUT_LIMITS.decks),
    zones: z.array(LayoutZoneSchema).max(LAYOUT_LIMITS.zones),
    elements: z.array(LayoutElementSchema).max(LAYOUT_LIMITS.elements),
    /** Aforo total de personas de la unidad (autoridad marítima o tarjeta), aunque la suma de zonas lo supere. */
    totalPersons: z.number().int().min(1).max(5000).nullable(),
  })
  .strict();
export type LayoutDocument = z.infer<typeof LayoutDocumentSchema>;

/** Celdas que mide una longitud en metros con la escala del plano. */
export const cells = (meters: number, cellCm: 25 | 50) => Math.round((meters * 100) / cellCm);

/** Grilla de un piso: columnas (ancho) y filas (largo, de proa a popa) con la escala del plano. */
export function deckGrid(
  doc: Pick<LayoutDocument, 'cellCm'>,
  deck: LayoutDeck,
): { cols: number; rows: number } {
  return { cols: cells(deck.widthM, doc.cellCm), rows: cells(deck.lengthM, doc.cellCm) };
}

/** Un documento vacío: un piso con medidas típicas y nada más. */
export function emptyLayout(modality: 'LAND' | 'RIVER', cellCm: 25 | 50 = 50): LayoutDocument {
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    cellCm,
    decks: [
      modality === 'LAND'
        ? { index: 0, name: 'Piso 1', lengthM: 12, widthM: 2.5 }
        : { index: 0, name: 'Piso 1', lengthM: 16, widthM: 5 },
    ],
    zones: [],
    elements: [],
    totalPersons: null,
  };
}

// -----------------------------------------------------------------------------------------------------------------
// Reglas para publicar
// -----------------------------------------------------------------------------------------------------------------

export type LayoutIssue = { path: string; message: string };

const inside = (r: Rect, o: Rect) =>
  r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h;
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const wh = (g: { cols: number; rows: number }) => ({ w: g.cols, h: g.rows });
const rectOf = (e: { x: number; y: number; w: number; h: number }): Rect => ({
  x: e.x,
  y: e.y,
  w: e.w,
  h: e.h,
});

/**
 * Todo lo que impide publicar una versión, con la ruta del dato y un mensaje claro. El servidor lo exige al publicar;
 * el editor (6.4) lo muestra antes. Las reglas:
 * - códigos únicos de zona y de elemento; cubiertas con índices únicos y consecutivos desde 0;
 * - zona: dentro de su cubierta, sin solaparse con otra zona de la misma cubierta, con un modo y un servicio que su
 *   tipo admite, y con las dimensiones de capacidad que admite (POOLED: al menos una);
 * - elemento: dentro de su cubierta; si es de inventario, en una zona ASSIGNED que admite su tipo y dentro de ella;
 *   los elementos que ocupan espacio no se solapan (las camas, sí, con su camarote);
 * - cama: dentro de su camarote, con capacidad 1 o 2; un camarote con camas no se vende por sí mismo y su capacidad es
 *   la suma de sus camas; solo un camarote con camas se puede vender completo;
 * - zona ASSIGNED con al menos un elemento asignable;
 * - aforo total, si se indica, mayor que cero (puede ser menor que la suma de las zonas: es el tope).
 */
export function validateLayout(doc: LayoutDocument): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  const decks = new Map(doc.decks.map((d) => [d.index, d]));
  doc.decks.forEach((d, i) => {
    if (d.index !== i) add(`decks.${i}.index`, 'Las cubiertas se numeran 0, 1, 2… en orden');
  });

  const zoneByCode = new Map<string, LayoutZone>();
  doc.zones.forEach((z, i) => {
    const p = `zones.${i}`;
    if (zoneByCode.has(z.code)) add(`${p}.code`, `Código de zona repetido: ${z.code}`);
    zoneByCode.set(z.code, z);
    const deck = decks.get(z.deck);
    const rules = ZONE_RULES[z.kind];
    if (!deck) add(`${p}.deck`, `La zona ${z.code} está en una cubierta que no existe`);
    else if (!inside(z.rect, { x: 0, y: 0, ...wh(deckGrid(doc, deck)) })) {
      add(`${p}.rect`, `La zona ${z.code} se sale de la cubierta`);
    }
    if (!rules.services.includes(z.service))
      add(`${p}.service`, `Ese servicio no corresponde a una zona de este tipo`);
    const seen = new Set<string>();
    z.capacity.forEach((c, j) => {
      if (!rules.dimensions.includes(c.dimension)) {
        add(`${p}.capacity.${j}`, `Una zona de este tipo no mide ${DIMENSION_LABEL[c.dimension]}`);
      }
      if (seen.has(c.dimension)) add(`${p}.capacity.${j}`, 'Dimensión repetida');
      seen.add(c.dimension);
      if (c.dimension === 'PERSONS' || c.dimension === 'UNITS') {
        if (!Number.isInteger(c.value)) add(`${p}.capacity.${j}`, 'Las personas y las unidades son enteras');
      }
    });
    if (rules.needsCapacity && z.capacity.length === 0) {
      add(
        `${p}.capacity`,
        `La zona ${z.code} necesita su capacidad (${rules.dimensions.map((d) => DIMENSION_LABEL[d]).join(', ')})`,
      );
    }
    if (z.constraints && z.kind !== 'VEHICLE_DECK' && z.kind !== 'CARGO_DECK') {
      add(`${p}.constraints`, 'Las medidas máximas solo aplican a cubiertas de carga o de vehículos');
    }
  });
  doc.zones.forEach((a, i) =>
    doc.zones.forEach((b, j) => {
      if (j > i && a.deck === b.deck && overlaps(a.rect, b.rect)) {
        add(`zones.${j}.rect`, `Las zonas ${a.code} y ${b.code} se solapan`);
      }
    }),
  );

  const elementByCode = new Map<string, LayoutElement>();
  doc.elements.forEach((e, i) => {
    if (elementByCode.has(e.code)) add(`elements.${i}.code`, `Código de elemento repetido: ${e.code}`);
    elementByCode.set(e.code, e);
  });
  const childrenOf = new Map<string, LayoutElement[]>();
  for (const e of doc.elements) {
    if (e.parentCode) childrenOf.set(e.parentCode, [...(childrenOf.get(e.parentCode) ?? []), e]);
  }

  doc.elements.forEach((e, i) => {
    const p = `elements.${i}`;
    const deck = decks.get(e.deck);
    if (!deck) add(`${p}.deck`, `${e.code} está en una cubierta que no existe`);
    else if (!inside(rectOf(e), { x: 0, y: 0, ...wh(deckGrid(doc, deck)) })) {
      add(`${p}`, `${e.code} se sale de la cubierta`);
    }
    const inventory = INVENTORY_ELEMENT_KINDS.includes(e.kind);
    const zone = e.zoneCode ? zoneByCode.get(e.zoneCode) : undefined;
    if (e.zoneCode && !zone) add(`${p}.zoneCode`, `${e.code} está en una zona que no existe`);
    if (inventory) {
      if (!zone) add(`${p}.zoneCode`, `${e.code} debe estar en una zona`);
      else {
        const rules = ZONE_RULES[zone.kind];
        if (rules.mode !== 'ASSIGNED' || !rules.elements.includes(e.kind)) {
          add(`${p}.zoneCode`, `Un elemento de este tipo no va en la zona ${zone.code}`);
        } else if (zone.deck !== e.deck || !inside(rectOf(e), zone.rect)) {
          add(`${p}`, `${e.code} se sale de su zona ${zone.code}`);
        }
      }
    }
    if (e.kind === 'BED') {
      const parent = e.parentCode ? elementByCode.get(e.parentCode) : undefined;
      if (e.capacity > 2) add(`${p}.capacity`, 'Una cama es para 1 o 2 personas');
      if (e.parentCode && (!parent || parent.kind !== 'CABIN')) {
        add(`${p}.parentCode`, `La cama ${e.code} debe estar en un camarote`);
      } else if (parent && (parent.deck !== e.deck || !inside(rectOf(e), rectOf(parent)))) {
        add(`${p}`, `La cama ${e.code} se sale de su camarote ${parent.code}`);
      } else if (parent && parent.zoneCode !== e.zoneCode) {
        add(`${p}.zoneCode`, `La cama ${e.code} debe estar en la misma zona que su camarote`);
      }
    } else if (e.parentCode) {
      add(`${p}.parentCode`, 'Solo las camas van dentro de un camarote');
    }
    if (e.kind === 'SEAT' && e.capacity !== 1) add(`${p}.capacity`, 'Un asiento es para una persona');
    if (e.kind === 'VEHICLE_SLOT' && e.capacity !== 1)
      add(`${p}.capacity`, 'Un espacio de vehículo es para un vehículo');
    if (e.kind === 'CABIN') {
      const beds = childrenOf.get(e.code) ?? [];
      if (beds.length > 0) {
        const sum = beds.reduce((s, b) => s + b.capacity, 0);
        if (e.capacity !== sum)
          add(`${p}.capacity`, `El camarote ${e.code} es para ${sum} (la suma de sus camas)`);
      } else if (e.sellableAsUnit) {
        add(`${p}.sellableAsUnit`, `El camarote ${e.code} no tiene camas: ya se vende completo`);
      }
    } else if (e.sellableAsUnit) {
      add(`${p}.sellableAsUnit`, 'Solo un camarote con camas se vende completo');
    }
  });

  // Solapamiento: todo lo que ocupa espacio (no los rótulos); una cama solo puede estar sobre su camarote.
  const solid = doc.elements.map((e, i) => ({ e, i })).filter(({ e }) => e.kind !== 'LABEL');
  for (let a = 0; a < solid.length; a++) {
    for (let b = a + 1; b < solid.length; b++) {
      const x = solid[a];
      const y = solid[b];
      if (!x || !y || x.e.deck !== y.e.deck || !overlaps(rectOf(x.e), rectOf(y.e))) continue;
      const nested = x.e.parentCode === y.e.code || y.e.parentCode === x.e.code;
      if (!nested) add(`elements.${y.i}`, `${x.e.code} y ${y.e.code} se solapan`);
    }
  }

  doc.zones.forEach((z, i) => {
    if (ZONE_RULES[z.kind].mode !== 'ASSIGNED') return;
    const has = doc.elements.some((e) => e.zoneCode === z.code && INVENTORY_ELEMENT_KINDS.includes(e.kind));
    if (!has) add(`zones.${i}`, `La zona ${z.code} no tiene ningún elemento que vender`);
  });
  if (doc.zones.length === 0) add('zones', 'Añade al menos una zona con capacidad');
  return issues;
}

export const DIMENSION_LABEL: Record<CapacityDimension, string> = {
  PERSONS: 'personas',
  UNITS: 'unidades',
  WEIGHT_KG: 'kg',
  VOLUME_M3: 'm³',
  LINEAR_M: 'metros lineales',
};

// -----------------------------------------------------------------------------------------------------------------
// Inventario derivado (lo que materializará un viaje en la Fase 7)
// -----------------------------------------------------------------------------------------------------------------

export const DerivedResourceSchema = z.object({
  code: z.string(),
  kind: ElementKindSchema,
  zoneCode: z.string(),
  parentCode: z.string().nullable(),
  /** Personas o unidades que ocupa. */
  capacity: z.number().int(),
  priceClassCode: z.string(),
  /** Se vende por sí mismo (un camarote con camas, no: se venden sus camas, o todas a la vez si sellableAsUnit). */
  isSellable: z.boolean(),
  sellableAsUnit: z.boolean(),
});
export type DerivedResource = z.infer<typeof DerivedResourceSchema>;

export const DerivedPoolSchema = z.object({
  scope: z.enum(['ZONE', 'VEHICLE']),
  zoneCode: z.string().nullable(),
  dimension: CapacityDimensionSchema,
  capacity: z.number(),
});
export type DerivedPool = z.infer<typeof DerivedPoolSchema>;

export const InventorySummarySchema = z.object({
  seats: z.number().int(),
  beds: z.number().int(),
  cabins: z.number().int(),
  vehicleSlots: z.number().int(),
  /** Personas en elementos asignables (asientos, camas, camarotes sin camas). */
  assignedPersons: z.number().int(),
  /** Personas en zonas por cantidad (zona libre, hamacas). */
  pooledPersons: z.number().int(),
  /** Tope de personas de la unidad (aforo), o null. */
  totalPersons: z.number().int().nullable(),
});
export type InventorySummary = z.infer<typeof InventorySummarySchema>;

export const DerivedInventorySchema = z.object({
  resources: z.array(DerivedResourceSchema),
  pools: z.array(DerivedPoolSchema),
  summary: InventorySummarySchema,
});
export type DerivedInventory = z.infer<typeof DerivedInventorySchema>;

/**
 * Inventario que tendrá un viaje con esta versión (capacity-and-inventory §2–4). Supone un documento válido.
 * - Recursos: asientos, camas, espacios de vehículo y camarotes. Un camarote con camas aparece como recurso padre no
 *   vendible por sí mismo (se venden sus camas, o todas a la vez si `sellableAsUnit`); sin camas, se vende entero.
 * - Pools: cada regla de capacidad de una zona (ZONE) y, si hay aforo total, el pool PERSONS de la unidad (VEHICLE),
 *   que consumirá toda venta de pasajero (ej. H).
 */
/**
 * Clase de precio por defecto de un elemento (Fase 6.4, zonas mixtas): la cama, CAMA; el camarote, CAMAROTE; el
 * asiento, la de su zona (o GENERAL, o VIP en una zona VIP); el espacio de vehículo, la de su zona o VEHICULO.
 */
function defaultPriceClass(kind: ElementKind, zone: LayoutZone | undefined): string {
  if (kind === 'BED') return 'CAMA';
  if (kind === 'CABIN') return 'CAMAROTE';
  if (zone?.priceClassCode) return zone.priceClassCode;
  if (kind === 'SEAT') return zone?.kind === 'VIP' ? 'VIP' : 'GENERAL';
  return zone ? ZONE_RULES[zone.kind].priceClass : 'GENERAL';
}

export function deriveInventory(doc: LayoutDocument): DerivedInventory {
  const zones = new Map(doc.zones.map((z) => [z.code, z]));
  const parents = new Set(doc.elements.filter((e) => e.parentCode).map((e) => e.parentCode));
  const resources: DerivedResource[] = doc.elements
    .filter((e) => INVENTORY_ELEMENT_KINDS.includes(e.kind) && e.zoneCode)
    .map((e) => {
      const zone = zones.get(e.zoneCode ?? '');
      const isParent = e.kind === 'CABIN' && parents.has(e.code);
      return {
        code: e.code,
        kind: e.kind,
        zoneCode: e.zoneCode ?? '',
        parentCode: e.parentCode,
        capacity: e.capacity,
        priceClassCode: e.priceClassCode ?? defaultPriceClass(e.kind, zone),
        isSellable: !isParent,
        sellableAsUnit: isParent && e.sellableAsUnit,
      };
    });
  const pools: DerivedPool[] = doc.zones.flatMap((z) =>
    z.capacity.map((c) => ({
      scope: 'ZONE' as const,
      zoneCode: z.code,
      dimension: c.dimension,
      capacity: c.value,
    })),
  );
  if (doc.totalPersons !== null) {
    pools.push({ scope: 'VEHICLE', zoneCode: null, dimension: 'PERSONS', capacity: doc.totalPersons });
  }
  const passenger = (code: string) => zones.get(code)?.service === 'PASSENGER';
  const count = (k: ElementKind) => resources.filter((r) => r.kind === k).length;
  return {
    resources,
    pools,
    summary: {
      seats: count('SEAT'),
      beds: count('BED'),
      cabins: count('CABIN'),
      vehicleSlots: count('VEHICLE_SLOT'),
      assignedPersons: resources
        .filter((r) => r.isSellable && passenger(r.zoneCode))
        .reduce((s, r) => s + r.capacity, 0),
      pooledPersons: pools
        .filter((p) => p.scope === 'ZONE' && p.dimension === 'PERSONS')
        .reduce((s, p) => s + p.capacity, 0),
      totalPersons: doc.totalPersons,
    },
  };
}

// -----------------------------------------------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------------------------------------------

export const LayoutVersionStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
export type LayoutVersionStatus = z.infer<typeof LayoutVersionStatusSchema>;

export const CreateLayoutRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    modality: ModalitySchema,
    /** Opcional: el layout solo se asigna a vehículos de este tipo. */
    vehicleTypeId: z.uuid().nullable(),
    /** Contenido inicial del borrador (p. ej., una plantilla); si falta, una cubierta vacía. */
    document: LayoutDocumentSchema.nullable(),
  })
  .strict();
export type CreateLayoutRequest = z.infer<typeof CreateLayoutRequestSchema>;

export const UpdateLayoutRequestSchema = z
  .object({ name: z.string().trim().min(2).max(60), vehicleTypeId: z.uuid().nullable() })
  .strict();
export type UpdateLayoutRequest = z.infer<typeof UpdateLayoutRequestSchema>;

export const SaveLayoutDraftRequestSchema = z.object({ document: LayoutDocumentSchema }).strict();
export type SaveLayoutDraftRequest = z.infer<typeof SaveLayoutDraftRequestSchema>;

export const LayoutVersionSummarySchema = z.object({
  version: z.number().int(),
  status: LayoutVersionStatusSchema,
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
  summary: InventorySummarySchema,
  /** Vehículos con esta versión asignada hoy o en el futuro. */
  assignedVehicles: z.number().int(),
});
export type LayoutVersionSummary = z.infer<typeof LayoutVersionSummarySchema>;

export const LayoutSchema = z.object({
  id: z.string(),
  name: z.string(),
  modality: ModalitySchema,
  vehicleTypeId: z.string().nullable(),
  vehicleTypeName: z.string().nullable(),
  archived: z.boolean(),
  versions: z.array(LayoutVersionSummarySchema),
});
export type Layout = z.infer<typeof LayoutSchema>;

export const LayoutsResponseSchema = z.object({ layouts: z.array(LayoutSchema) });
export type LayoutsResponse = z.infer<typeof LayoutsResponseSchema>;

export const LayoutVersionDetailSchema = z.object({
  layoutId: z.string(),
  version: z.number().int(),
  status: LayoutVersionStatusSchema,
  document: LayoutDocumentSchema,
  /** Lo que impide publicarla (vacío en una versión publicada). */
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
  inventory: DerivedInventorySchema,
});
export type LayoutVersionDetail = z.infer<typeof LayoutVersionDetailSchema>;

export const CreateLayoutAssignmentRequestSchema = z
  .object({
    layoutId: z.uuid(),
    version: z.number().int().min(1),
    validFrom: z.iso.date(),
    validTo: z.iso.date().nullable(),
  })
  .strict()
  .refine((a) => a.validTo === null || a.validTo > a.validFrom, {
    message: 'El fin debe ser posterior al inicio',
    path: ['validTo'],
  });
export type CreateLayoutAssignmentRequest = z.infer<typeof CreateLayoutAssignmentRequestSchema>;

export const EndLayoutAssignmentRequestSchema = z.object({ validTo: z.iso.date() }).strict();
export type EndLayoutAssignmentRequest = z.infer<typeof EndLayoutAssignmentRequestSchema>;

export const LayoutAssignmentSchema = z.object({
  id: z.string(),
  vehicleId: z.string(),
  layoutId: z.string(),
  layoutName: z.string(),
  version: z.number().int(),
  /** Desde (incluido) y hasta (excluido), fechas de calendario de la empresa. */
  validFrom: z.iso.date(),
  validTo: z.iso.date().nullable(),
});
export type LayoutAssignment = z.infer<typeof LayoutAssignmentSchema>;

export const LayoutAssignmentsResponseSchema = z.object({ assignments: z.array(LayoutAssignmentSchema) });
export type LayoutAssignmentsResponse = z.infer<typeof LayoutAssignmentsResponseSchema>;
