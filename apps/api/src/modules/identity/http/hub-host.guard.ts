import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../../../common/errors/app-error';
import { ENV } from '../../../config/env.module';
import type { Env } from '../../../config/env';
import { normalizeHost } from '../../tenancy/host';

/**
 * Las rutas del hub solo responden en el host del hub (AUTH_HUB_HOST). En cualquier otro host, 404, igual que
 * un recurso inexistente. `req.hostname` solo considera X-Forwarded-Host desde el proxy de confianza (ADR-004).
 */
@Injectable()
export class HubHostGuard implements CanActivate {
  private readonly hubHost: string;

  constructor(@Inject(ENV) env: Env) {
    this.hubHost = env.AUTH_HUB_HOST;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (normalizeHost(request.hostname) !== this.hubHost)
      throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
    return true;
  }
}
