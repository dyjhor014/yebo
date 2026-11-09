import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/errors/app-error';
import { PermissionService } from '../permission.service';
import { routePolicyForContext } from '../route-policy';

/**
 * Guard GLOBAL de permisos (`@RequirePermission`, security.md §2). Va después de AuthenticationGuard.
 * Las reglas de pertenencia ("solo quien abrió la caja la cierra") y el aislamiento por id (404 para recursos de
 * otro tenant, multitenancy §7.1) los aplican los servicios.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = routePolicyForContext(this.reflector, context);
    if (policy.kind !== 'protected' || policy.permission === null) return true;
    if (!(await this.permissions.current()).has(policy.permission)) {
      throw new AppError('FORBIDDEN', 'No tienes permiso para realizar esta operación', 403);
    }
    return true;
  }
}
