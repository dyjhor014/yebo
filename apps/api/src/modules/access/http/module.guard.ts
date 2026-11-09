import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/errors/app-error';
import { EffectiveModulesService } from '../effective-modules.service';
import { requiredModuleOf, routePolicyForContext } from '../route-policy';

/**
 * Guard GLOBAL de módulos (`@RequiresModule`, multitenancy §6). La autoridad es el backend: aunque la interfaz oculte
 * lo no habilitado, una ruta de un módulo no contratado responde 403 `MODULE_NOT_ENABLED`.
 */
@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly modules: EffectiveModulesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = requiredModuleOf(this.reflector, context);
    if (!required) return true;
    if (routePolicyForContext(this.reflector, context).kind !== 'protected') {
      throw new Error('@RequiresModule solo se admite en rutas de empresa protegidas');
    }
    if (!(await this.modules.current()).has(required)) {
      throw new AppError('MODULE_NOT_ENABLED', 'La empresa no tiene habilitado este módulo', 403);
    }
    return true;
  }
}
