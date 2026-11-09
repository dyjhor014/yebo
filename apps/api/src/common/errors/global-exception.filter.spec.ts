import { NotFoundException, ServiceUnavailableException, type ArgumentsHost } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import { AppError } from './app-error';
import { GlobalExceptionFilter, mapException } from './global-exception.filter';

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

  it('la saturación del pool (P2028, P2024) es un 503 reintentable, no un 500', () => {
    for (const code of ['P2028', 'P2024']) {
      const error = Object.assign(new Error('Unable to start a transaction in the given time'), {
        name: 'PrismaClientKnownRequestError',
        code,
      });
      expect(mapException(error)).toEqual({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: 'Servicio no disponible temporalmente',
        retryAfterSeconds: 1,
      });
    }
    // Otro error de Prisma (p. ej. P2002) no es transitorio: sigue siendo interno si nadie lo traduce.
    const other = Object.assign(new Error('x'), { name: 'PrismaClientKnownRequestError', code: 'P2002' });
    expect(mapException(other).status).toBe(500);
  });

  it('oculta errores desconocidos tras INTERNAL_ERROR', () => {
    expect(mapException(new Error('password=secreto en SQL'))).toEqual({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Error interno',
    });
  });
});

describe('GlobalExceptionFilter', () => {
  function run(exception: unknown) {
    const headers = new Map<string, string>();
    const sent: { status?: number; body?: unknown } = {};
    const response = {
      getHeader: () => undefined,
      setHeader: (k: string, v: string) => headers.set(k, v),
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: unknown) {
        sent.body = body;
      },
    };
    const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
    const cls = {
      isActive: () => false,
      getId: () => undefined,
    } as unknown as ClsService<RequestContextStore>;
    new GlobalExceptionFilter(cls).catch(exception, host);
    return { headers, sent };
  }

  it('un 503 por saturación lleva Retry-After; un 500 no', () => {
    const saturated = run(
      Object.assign(new Error('x'), { name: 'PrismaClientKnownRequestError', code: 'P2028' }),
    );
    expect(saturated.sent.status).toBe(503);
    expect(saturated.headers.get('Retry-After')).toBe('1');
    const unknown = run(new Error('fallo'));
    expect(unknown.sent.status).toBe(500);
    expect(unknown.headers.has('Retry-After')).toBe(false);
  });
});
