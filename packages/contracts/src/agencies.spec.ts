import { CreateAgencyRequestSchema, UpdateAgencyRequestSchema, isValidRuc } from './agencies';

describe('isValidRuc (Fase 6.5)', () => {
  it('acepta RUC con prefijo de contribuyente y dígito verificador correcto', () => {
    for (const ruc of ['20100047218', '20131312955', '20607654329', '10467793549']) {
      expect(isValidRuc(ruc)).toBe(true);
    }
  });

  it('rechaza el dígito verificador equivocado, otros prefijos y otros largos', () => {
    for (const ruc of ['20100047219', '30100047218', '2010004721', '201000472180', '2010004721A', '']) {
      expect(isValidRuc(ruc)).toBe(false);
    }
  });
});

describe('CreateAgencyRequestSchema', () => {
  const base = { taxId: ' 20100047218 ', name: ' Agencia Malecón ' };

  it('normaliza el texto y convierte los datos de contacto vacíos en null', () => {
    expect(
      CreateAgencyRequestSchema.parse({
        ...base,
        contactName: '',
        contactPhone: '  ',
        contactEmail: 'Ventas@Agencia.PE',
      }),
    ).toEqual({
      taxId: '20100047218',
      name: 'Agencia Malecón',
      contactName: null,
      contactPhone: null,
      contactEmail: 'ventas@agencia.pe',
    });
  });

  it('rechaza RUC no válido, teléfono o correo mal formados y campos de más', () => {
    const ok = { ...base, contactName: null, contactPhone: null, contactEmail: null };
    expect(CreateAgencyRequestSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, taxId: '20100047219' },
      { ...ok, contactPhone: 'llamar' },
      { ...ok, contactEmail: 'no-es-correo' },
      { ...ok, name: 'A' },
      { ...ok, commission: 5 },
    ]) {
      expect(CreateAgencyRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('al editar, el RUC no se acepta: no cambia después del alta', () => {
    expect(
      UpdateAgencyRequestSchema.safeParse({
        name: 'Otra',
        taxId: '20100047218',
        contactName: null,
        contactPhone: null,
        contactEmail: null,
      }).success,
    ).toBe(false);
  });
});
