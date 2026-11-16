import { boatTemplate, deriveInventory, emptyLayout, validateLayout } from '@yebo/contracts';
import {
  addBed,
  addCabin,
  addDeck,
  addSeat,
  addSeatRows,
  addZone,
  issueTarget,
  moveElement,
  passengerZones,
  removeDeck,
  removeElement,
  reshapeZone,
  setZoneCapacity,
  updateElement,
} from './layout-editor';

const zoneOf = (doc: ReturnType<typeof boatTemplate>, code: string) =>
  doc.zones.find((z) => z.code === code)!;

describe('editor de planos (6.4c)', () => {
  it('filas de asientos 2 + 3 debajo de las existentes; la numeración continúa y el plano sigue publicable', () => {
    const boat = boatTemplate();
    const salon = { ...zoneOf(boat, 'ASIENTOS'), rect: { x: 0, y: 2, w: 10, h: 16 } };
    const doc = { ...boat, zones: boat.zones.map((z) => (z.code === 'ASIENTOS' ? salon : z)) };
    const r = addSeatRows(doc, salon, [2, 3], 1);
    const added = r.doc.elements.filter((e) => e.code.startsWith('7'));
    expect(added.map((e) => e.code)).toEqual(['7A', '7B', '7C', '7D', '7E']);
    expect(added[0]).toMatchObject({ y: 15, zoneCode: 'ASIENTOS', deck: 1 }); // última fila en y=13, una fila por metro
    expect(r.message).toMatch(/^5 asientos en 1 fila 2 \+ 3 \(filas 7 a 7\)$/);
    expect(validateLayout(r.doc)).toEqual([]);
  });

  it('avisa cuando las filas no caben en la zona', () => {
    const boat = boatTemplate();
    const r = addSeatRows(boat, zoneOf(boat, 'ASIENTOS'), [3, 3], 4);
    expect(r.message).toMatch(/no caben en la zona/);
    expect(validateLayout(r.doc).some((i) => i.message.includes('se sale de su zona'))).toBe(true);
  });

  it('zona mixta: asiento, camarote y cama en la zona de asientos, en huecos libres; precio por elemento', () => {
    let doc = boatTemplate();
    const salon = zoneOf(doc, 'ASIENTOS');
    doc = addCabin(doc, salon, 1).doc;
    doc = addBed(doc, salon).doc;
    doc = addSeat(doc, salon).doc;
    expect(
      doc.elements.filter((e) => ['C5', 'C5-B1', 'K1', 'S1'].includes(e.code)).map((e) => [e.code, e.x, e.y]),
    ).toEqual([
      ['C5', 4, 2],
      ['C5-B1', 4, 2],
      ['K1', 4, 6],
      ['S1', 0, 2],
    ]);
    expect(validateLayout(doc)).toEqual([]);
    const price = (code: string) =>
      deriveInventory(doc).resources.find((r) => r.code === code)?.priceClassCode;
    expect([price('S1'), price('C5-B1'), price('K1')]).toEqual(['GENERAL', 'CAMA', 'CAMA']);
    expect(passengerZones(doc, 1).map((z) => z.code)).toEqual(['ASIENTOS']);
  });

  it('una zona nueva ocupa todo el ancho en el primer tramo libre; si no hay, lo dice', () => {
    const doc = emptyLayout('RIVER'); // 16 × 5 m a 50 cm: 10 × 32 celdas
    const a = addZone(doc, 0, 'FREE_ZONE', 6);
    expect(a.doc.zones[0]).toMatchObject({
      code: 'LIBRE1',
      rect: { x: 0, y: 0, w: 10, h: 12 },
      service: 'PASSENGER',
    });
    const b = addZone(a.doc, 0, 'HOLD', 10);
    expect(b.doc.zones[1]).toMatchObject({ code: 'BODEGA1', rect: { y: 12, h: 20 }, service: 'PARCEL' });
    const c = addZone(b.doc, 0, 'HAMMOCK', 3);
    expect(c.message).toMatch(/no tiene un tramo libre de 3 m/);
  });

  it('mover y redimensionar una zona nunca la saca del piso', () => {
    const boat = boatTemplate();
    const wider = reshapeZone(boat, 'TERRAZA', (r) => ({ ...r, w: r.w + 5, x: r.x + 3 }));
    expect(zoneOf(wider.doc, 'TERRAZA').rect).toMatchObject({ x: 0, w: 10 });
    const down = reshapeZone(boat, 'TERRAZA', (r) => ({ ...r, y: r.y + 50 }));
    expect(zoneOf(down.doc, 'TERRAZA').rect).toMatchObject({ y: 4, h: 12 }); // 8 m = 16 filas
    const tiny = reshapeZone(boat, 'TERRAZA', (r) => ({ ...r, w: 0, h: 1 }));
    expect(zoneOf(tiny.doc, 'TERRAZA').rect).toMatchObject({ w: 2, h: 2 });
    expect(down.message).toBe('Terraza: 5 m de ancho por 6 m de largo, desde la columna 1, fila 5');
  });

  it('mover un camarote lleva sus camas; se detiene en el borde', () => {
    const boat = boatTemplate();
    const r = moveElement(boat, 'C2', 5, 0);
    const pos = (code: string) => r.doc.elements.find((e) => e.code === code)!;
    expect([pos('C2').x, pos('C2-B1').x, pos('C2-B2').x]).toEqual([6, 6, 8]); // ya estaba en el borde derecho
    expect(r.message).toBe('C2 ya está en el borde del piso');
    const left = moveElement(boat, 'C2', -1, 0);
    expect(left.doc.elements.find((e) => e.code === 'C2-B2')!.x).toBe(7);
  });

  it('quitar: el camarote se lleva sus camas; una cama ajusta el camarote', () => {
    const boat = boatTemplate();
    expect(removeElement(boat, 'C1').doc.elements.some((e) => e.code.startsWith('C1'))).toBe(false);
    const oneBed = removeElement(boat, 'C1-B2').doc;
    expect(oneBed.elements.find((e) => e.code === 'C1')).toMatchObject({ capacity: 1, sellableAsUnit: true });
    const shared = updateElement(boat, 'C1-B1', { capacity: 2 });
    expect(shared.elements.find((e) => e.code === 'C1')!.capacity).toBe(3);
    expect(validateLayout(shared)).toEqual([]);
  });

  it('pisos: hasta 6; solo se quita uno vacío y los siguientes se renumeran', () => {
    let doc = boatTemplate(); // 4 pisos
    doc = addDeck(doc).doc;
    doc = addDeck(doc).doc;
    expect(doc.decks).toHaveLength(6);
    expect(addDeck(doc).message).toBe('Un plano tiene como mucho 6 pisos');
    expect(removeDeck(doc, 1).message).toMatch(/^Solo se quita un piso vacío/);
    const withEmpty = {
      ...doc,
      zones: doc.zones.filter((z) => z.deck !== 2),
      elements: doc.elements.filter((e) => e.deck !== 2),
    };
    const r = removeDeck(withEmpty, 2);
    expect(r.doc.decks.map((d) => [d.index, d.name])).toEqual([
      [0, 'Piso 1'],
      [1, 'Piso 2'],
      [2, 'Bodega'],
      [3, 'Piso 5'],
      [4, 'Piso 6'],
    ]);
    expect(r.doc.zones.find((z) => z.code === 'BODEGA')!.deck).toBe(2);
    expect(validateLayout(r.doc)).toEqual([]);
  });

  it('capacidad de una zona: fijar, cambiar y quitar una dimensión', () => {
    const boat = boatTemplate();
    let doc = setZoneCapacity(boat, 'BODEGA', 'UNITS', 300);
    expect(zoneOf(doc, 'BODEGA').capacity.map((c) => c.dimension)).toEqual([
      'WEIGHT_KG',
      'VOLUME_M3',
      'UNITS',
    ]);
    doc = setZoneCapacity(doc, 'BODEGA', 'VOLUME_M3', null);
    expect(zoneOf(doc, 'BODEGA').capacity).toEqual([
      { dimension: 'WEIGHT_KG', value: 8000 },
      { dimension: 'UNITS', value: 300 },
    ]);
  });

  it('de un problema de validateLayout a lo que hay que seleccionar', () => {
    const boat = boatTemplate();
    const i = boat.elements.findIndex((e) => e.code === '3B');
    expect(issueTarget(boat, `elements.${i}`)).toEqual({ deck: 1, select: { type: 'element', code: '3B' } });
    expect(issueTarget(boat, 'zones.4.capacity')).toEqual({
      deck: 2,
      select: { type: 'zone', code: 'TERRAZA' },
    });
    expect(issueTarget(boat, 'zones')).toBeNull();
  });
});
