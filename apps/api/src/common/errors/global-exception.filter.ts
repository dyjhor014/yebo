import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ErrorCode, ErrorResponse, ValidationIssue } from '@yebo/contracts';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { ZodValidationException } from 'nestjs-zod';
import type { ZodError } from 'zod';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { AppError } from './app-error';

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/** Mensajes genéricos: nunca se reenvían mensajes internos de excepciones de terceros. */
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'Los datos enviados no son válidos',
  BAD_REQUEST: 'Solicitud inválida',
  UNAUTHENTICATED: 'Se requiere autenticación',
  PERMISSIONS_CHANGED: 'Tus permisos cambiaron; renueva la sesión',
  FORBIDDEN: 'No tiene permiso para realizar esta operación',
  TENANT_RESTRICTED: 'El estado de la empresa no permite esta operación',
  MODULE_NOT_ENABLED: 'La empresa no tiene habilitado este módulo',
  NOT_FOUND: 'Recurso no encontrado',
  CONFLICT: 'La operación entra en conflicto con el estado actual',
  PAYLOAD_TOO_LARGE: 'El contenido enviado excede el tamaño permitido',
  RATE_LIMITED: 'Demasiadas solicitudes; intente más tarde',
  SERVICE_UNAVAILABLE: 'Servicio no disponible temporalmente',
  INTERNAL_ERROR: 'Error interno',
};

export interface MappedError {
  status: number;
  code: ErrorCode;
  message: string;
  issues?: ValidationIssue[];
  /** Cabecera Retry-After (segundos) para errores transitorios. */
  retryAfterSeconds?: number;
}

/**
 * Saturación transitoria de la base: el pool no dio conexión a tiempo (P2028 al iniciar una transacción, P2024 en
 * una consulta suelta). Es un 503 reintentable, no un error interno (diagnóstico del 2026-11-10).
 */
const DB_SATURATION_CODES: ReadonlySet<string> = new Set(['P2028', 'P2024']);

function isDbSaturation(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false;
  const e = exception as { name?: unknown; code?: unknown };
  return (
    e.name === 'PrismaClientKnownRequestError' &&
    typeof e.code === 'string' &&
    DB_SATURATION_CODES.has(e.code)
  );
}

function mapZodIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment)),
    message: issue.message,
    code: issue.code,
  }));
}

/** Traducción pura de excepción → error público (probada de forma unitaria). */
export function mapException(exception: unknown): MappedError {
  if (exception instanceof AppError) {
    return { status: exception.httpStatus, code: exception.code, message: exception.message };
  }
  if (exception instanceof ZodValidationException) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: 'VALIDATION_FAILED',
      message: DEFAULT_MESSAGES.VALIDATION_FAILED,
      issues: mapZodIssues(exception.getZodError() as ZodError),
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = STATUS_TO_CODE[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
    return { status, code, message: DEFAULT_MESSAGES[code] };
  }
  if (isDbSaturation(exception)) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'SERVICE_UNAVAILABLE',
      message: DEFAULT_MESSAGES.SERVICE_UNAVAILABLE,
      retryAfterSeconds: 1,
    };
  }
  // Errores de body-parser (p. ej. cuerpo demasiado grande o JSON malformado) llegan como errores con `status`.
  if (typeof exception === 'object' && exception !== null && 'status' in exception) {
    const status = Number((exception as { status: unknown }).status);
    if (status === 413)
      return { status, code: 'PAYLOAD_TOO_LARGE', message: DEFAULT_MESSAGES.PAYLOAD_TOO_LARGE };
    if (status === 400) return { status, code: 'BAD_REQUEST', message: DEFAULT_MESSAGES.BAD_REQUEST };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_ERROR',
    message: DEFAULT_MESSAGES.INTERNAL_ERROR,
  };
}

/** Filtro global: todas las respuestas de error usan el formato de @yebo/contracts (ErrorResponse). */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(private readonly cls: ClsService<RequestContextStore>) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = mapException(exception);
    const traceId =
      (this.cls.isActive() && this.cls.getId()) || String(response.getHeader('x-request-id') ?? 'unknown');

    if (mapped.retryAfterSeconds !== undefined) {
      // Transitorio (p. ej. pool saturado): se avisa sin tratarlo como un fallo del código.
      this.logger.warn({ err: exception, traceId, event: 'transient_unavailable' }, 'Servicio saturado');
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    } else if (mapped.status >= 500) {
      // Se registra el error completo (con stack) en el servidor; el cliente solo recibe el código y el traceId.
      this.logger.error({ err: exception, traceId }, 'Error no controlado');
    }

    const body: ErrorResponse = {
      error: {
        code: mapped.code,
        message: mapped.message,
        traceId,
        ...(mapped.issues && { issues: mapped.issues }),
      },
    };
    response.status(mapped.status).json(body);
  }
}
