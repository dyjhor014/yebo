import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../common/errors/app-error';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantResolverService } from './tenant-resolver.service';

/**
 * Fija el tenant del request a partir del HOST (ADR-004; multitenancy §2, regla 1).
 * - Nunca lo toma del cuerpo, la query ni una cabecera del cliente.
 * - `req.hostname` solo considera X-Forwarded-Host si la petición llega del proxy de confianza
 *   (`trust proxy` = TRUST_PROXY, restringido a la IP de Nginx en producción).
 * - Host desconocido o dominio no verificado: 404, igual que un recurso inexistente.
 */
@Injectable()
export class TenantHostGuard implements CanActivate {
  constructor(
    private readonly resolver: TenantResolverService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const tenant = await this.resolver.resolve(request.hostname);
    if (!tenant) throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
    this.cls.set('tenantId', tenant.id);
    this.cls.set('tenant', tenant);
    return true;
  }
}
