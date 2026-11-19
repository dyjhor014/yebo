import {
  AddVehicleEquipmentRequestSchema,
  CreateInspectionRequestSchema,
  UpdateInspectionItemRequestSchema,
  suggestedResult,
} from './equipment';

const V = '0190f0a0-0000-7000-8000-000000000001';

describe('equipamiento e inspecciones (contrato)', () => {
  it('resultado sugerido por la cantidad encontrada (EQ-Q10): la persona decide al final', () => {
    expect(suggestedResult(40, null)).toBeNull();
    expect(suggestedResult(40, 40)).toBe('CONFORMING');
    expect(suggestedResult(40, 41)).toBe('CONFORMING');
    expect(suggestedResult(40, 38)).toBe('OBSERVED');
    expect(suggestedResult(40, 0)).toBe('NOT_AVAILABLE');
  });

  it('declarar: textos recortados, vacío = sin dato, cantidad positiva y un solo origen', () => {
    const item = (over: object = {}) => ({
      name: ' Extintor ',
      category: 'SAFETY',
      quantity: 2,
      description: '  ',
      status: 'OPERATIVE',
      expiresOn: null,
      serialNumber: ' EXT-1 ',
      catalogCode: 'EXTINTOR',
      tenantItemId: null,
      ...over,
    });
    const parsed = AddVehicleEquipmentRequestSchema.parse({ items: [item()] });
    expect(parsed.items[0]).toMatchObject({ name: 'Extintor', description: null, serialNumber: 'EXT-1' });
    for (const over of [
      { quantity: 0 },
      { name: 'X' },
      { status: 'ROTO' },
      { tenantItemId: V },
      { expiresOn: '2026-13-01' },
    ]) {
      expect(AddVehicleEquipmentRequestSchema.safeParse({ items: [item(over)] }).success).toBe(false);
    }
    expect(AddVehicleEquipmentRequestSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('inspección: una rectificación lleva la original y el motivo; el resultado de un elemento puede quedar sin marcar', () => {
    const base = { vehicleId: V, tripId: null, rectifiesId: null, rectificationReason: null };
    expect(CreateInspectionRequestSchema.safeParse(base).success).toBe(true);
    expect(CreateInspectionRequestSchema.safeParse({ ...base, rectifiesId: V }).success).toBe(false);
    expect(CreateInspectionRequestSchema.safeParse({ ...base, rectificationReason: 'Motivo' }).success).toBe(
      false,
    );
    expect(
      CreateInspectionRequestSchema.safeParse({ ...base, rectifiesId: V, rectificationReason: 'ab' }).success,
    ).toBe(false);
    expect(
      UpdateInspectionItemRequestSchema.parse({ result: null, foundQuantity: null, observation: ' ' }),
    ).toEqual({
      result: null,
      foundQuantity: null,
      observation: null,
    });
    expect(
      UpdateInspectionItemRequestSchema.safeParse({ result: 'ROTO', foundQuantity: null, observation: null })
        .success,
    ).toBe(false);
  });
});
