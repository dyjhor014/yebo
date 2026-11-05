import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import { AppError } from './app-error';
import { mapException } from './global-exception.filter';

describe('mapException', () => {
  it('respeta el código y el estado de AppError', () => {
    expect(mapException(new AppError('CONFLICT', 'Asiento no disponible', 409))).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'Asiento no disponible',
    });
  });

  it('traduce errores de validación Zod con issues', () => {
    const result = z.object({ pin: z.string().regex(/^[0-9]{4}$/) }).safeParse({ pin: '12' });
    if (result.success) throw new Error('debía fallar');
    const mapped = mapException(new ZodValidationException(result.error));
    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe('VALIDATION_FAILED');
    expect(mapped.issues?.[0]?.path).toEqual(['pin']);
  });

  it('traduce HttpException sin reenviar el mensaje interno', () => {
    expect(mapException(new NotFoundException('detalle interno de ruta'))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Recurso no encontrado',
    });
    expect(mapException(new ServiceUnavailableException()).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('traduce errores de body-parser', () => {
    expect(mapException(Object.assign(new Error('request entity too large'), { status: 413 })).code).toBe(
      'PAYLOAD_TOO_LARGE',
    );
  });

  it('oculta errores desconocidos tras INTERNAL_ERROR', () => {
    expect(mapException(new Error('password=secreto en SQL'))).toEqual({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Error interno',
    });
  });
});
