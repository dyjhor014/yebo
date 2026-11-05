import type { ErrorCode } from '@yebo/contracts';

/**
 * Error de negocio o de aplicación con código estable para el cliente.
 * Los módulos lanzan AppError (o subclases); el filtro global lo traduce al formato de error único.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}
