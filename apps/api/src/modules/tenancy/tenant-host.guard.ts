import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../common/errors/app-error';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { routePolicyForContext } from '../access/route-policy';
import { TenantResolverService } from './tenant-resolver.service';

/**
 * Fija el tenant del request a partir del HOST (ADR-004; multitenancy §2, regla 1).
 * - Guard GLOBAL (Fase 3.3), el primero de la cadena: toda ruta protegida y toda ruta `@Public('tenant')` exige
 *   un host de empresa verificado. Solo `@Public('hub')` y `@Public('none')` lo omiten.
 * - Nunca toma el tenant del cuerpo, la query ni una cabecera del cliente.
 * - `req.hostname` solo considera X-Forwarded-Host si la petición llega del proxy de confianza
 *   (`trust proxy` = TRUST_PROXY, restringido a la IP de Nginx en producción).
 * - Host desconocido o dominio no verificado: 404, igual que un recurso inexistente.
 */
@Injectable()
export class TenantHostGuard implements CanActivate {
  constructor(
    private readonly resolver: TenantResolverService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = routePolicyForContext(this.reflector, context);
    // Host de empresa: rutas de empresa y públicas de empresa. Hub, panel de administración y health, no.
    if (policy.kind === 'platform' || (policy.kind === 'public' && policy.scope !== 'tenant')) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const tenant = await this.resolver.resolve(request.hostname);
    if (!tenant) throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
    this.cls.set('tenantId', tenant.id);
    this.cls.set('tenant', tenant);
    return true;
  }
}
