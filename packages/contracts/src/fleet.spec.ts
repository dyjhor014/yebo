import {
  CreateVehicleRequestSchema,
  VehicleDocumentInputSchema,
  documentStatus,
  documentsSummary,
} from './fleet';

describe('documentStatus (Fase 6.2)', () => {
  it('vencido, por vencer (≤ 30 días, incluido el mismo día), vigente y sin vencimiento', () => {
    expect(documentStatus('2026-11-09', '2026-11-10')).toBe('EXPIRED');
    expect(documentStatus('2026-11-10', '2026-11-10')).toBe('EXPIRING');
    expect(documentStatus('2026-12-10', '2026-11-10')).toBe('EXPIRING'); // 30 días
    expect(documentStatus('2026-12-11', '2026-11-10')).toBe('VALID'); // 31 días
    expect(documentStatus(null, '2026-11-10')).toBe('NO_EXPIRY');
  });
});

describe('documentsSummary', () => {
  const today = '2026-11-10';
  it('sin documentos', () => {
    expect(documentsSummary([], today)).toEqual({ summary: 'NONE', nextExpiry: null });
  });
  it('una renovación deja al documento anterior como historia', () => {
    expect(
      documentsSummary(
        [
          { typeCode: 'SOAT', expiresOn: '2026-01-31' }, // vencido, pero renovado
          { typeCode: 'SOAT', expiresOn: '2027-01-31' },
        ],
        today,
      ),
    ).toEqual({ summary: 'OK', nextExpiry: '2027-01-31' });
  });
  it('el peor estado entre tipos y el próximo vencimiento', () => {
    expect(
      documentsSummary(
        [
          { typeCode: 'SOAT', expiresOn: '2027-01-31' },
          { typeCode: 'REVISION_TECNICA', expiresOn: '2026-11-25' },
          { typeCode: 'TARJETA_PROPIEDAD', expiresOn: null },
        ],
        today,
      ),
    ).toEqual({ summary: 'EXPIRING', nextExpiry: '2026-11-25' });
    expect(
      documentsSummary(
        [
          { typeCode: 'SOAT', expiresOn: '2026-10-01' },
          { typeCode: 'REVISION_TECNICA', expiresOn: '2026-11-25' },
        ],
        today,
      ).summary,
    ).toBe('EXPIRED');
  });
});

describe('esquemas de flota', () => {
  const vehicle = {
    code: 'bus-01',
    name: 'Bus 01',
    vehicleTypeId: '0190f0a0-0000-7000-8000-000000000001',
    registration: ' abc-123 ',
    status: 'ACTIVE',
    ownership: 'OWN',
    nominalCapacity: { passengers: 40, weightKg: 1500, volumeM3: null },
    features: ['Aire acondicionado'],
  };
  it('normaliza el código y la placa; rechaza campos desconocidos', () => {
    expect(CreateVehicleRequestSchema.parse(vehicle)).toMatchObject({
      code: 'BUS-01',
      registration: 'ABC-123',
    });
    expect(CreateVehicleRequestSchema.safeParse({ ...vehicle, photos: [] }).success).toBe(false);
    expect(CreateVehicleRequestSchema.safeParse({ ...vehicle, registration: '!!' }).success).toBe(false);
  });
  it('el vencimiento no es anterior a la emisión', () => {
    const doc = {
      typeCode: 'SOAT',
      number: 'S-1',
      issuedOn: '2026-02-01',
      expiresOn: '2026-01-31',
      fileAssetId: null,
    };
    expect(VehicleDocumentInputSchema.safeParse(doc).success).toBe(false);
    expect(VehicleDocumentInputSchema.safeParse({ ...doc, expiresOn: '2027-01-31' }).success).toBe(true);
  });
});
