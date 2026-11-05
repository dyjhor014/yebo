import { ErrorResponseSchema } from './errors';

describe('ErrorResponseSchema', () => {
  it('acepta un error con issues de validación', () => {
    const parsed = ErrorResponseSchema.parse({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Datos inválidos',
        traceId: 'abc',
        issues: [{ path: ['pin'], message: 'Debe tener 4 dígitos', code: 'invalid_format' }],
      },
    });
    expect(parsed.error.issues).toHaveLength(1);
  });

  it('rechaza códigos de error desconocidos', () => {
    expect(() =>
      ErrorResponseSchema.parse({ error: { code: 'SOMETHING', message: 'x', traceId: 't' } }),
    ).toThrow();
  });
});
