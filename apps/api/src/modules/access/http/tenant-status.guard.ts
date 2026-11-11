import { Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../../common/errors/app-error';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { Clock } from '../../identity/clock';
import { routePolicyForContext } from '../route-policy';
import { isOperationAllowed, tenantPhase, type TenantPhase } from '../tenant-operation';

const MESSAGE: Record<TenantPhase, string> = {
  TRIAL: '',
  ACTIVE: '',
  PAST_DUE: '',
  SUSPENDED:
    'La cuenta de la empresa está suspendida: puedes completar las operaciones existentes, pero no iniciar nuevas.',
  EXPIRED:
    'El periodo de la empresa venció: puedes completar las operaciones existentes, pero no iniciar nuevas.',
  CANCELLED_CLOSING:
    'La empresa está en su periodo de cierre: puedes completar las operaciones existentes y exportar tus datos.',
  CANCELLED_CLOSED: 'Esta empresa ya no está disponible en YEBO.',
};

/**
 * Guard GLOBAL del estado del tenant (`@TenantOperation`, ADR-023, multitenancy §5). El último de la cadena.
 * Aplica la matriz por defecto: la falta de pago bloquea nuevas obligaciones comerciales, nunca el cumplimiento de
 * las ya contraídas. Cada denegación se registra con la categoría y el estado (la tabla de auditoría llega con su
 * módulo; hasta entonces queda en el log estructurado).
 */
@Injectable()
export class TenantStatusGuard implements CanActivate {
  private readonly logger = new Logger('TenantStatusGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly clock: Clock,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const policy = routePolicyForContext(this.reflector, context);
    if (policy.kind === 'public') return true;
    const tenant = this.cls.get('tenant');
    if (!tenant) throw new Error('TenantHostGuard no fijó el tenant antes de TenantStatusGuard');
    const phase = tenantPhase(tenant, this.clock.now());
    if (isOperationAllowed(policy.operation, phase)) return true;
    this.logger.warn(
      {
        event: 'tenant_operation_denied',
        tenantId: tenant.id,
        tenantStatus: tenant.status,
        phase,
        category: policy.operation,
        membershipId: this.cls.get('principal')?.membershipId,
        route: `${context.getClass().name}.${context.getHandler().name}`,
      },
      'Operación denegada por el estado del tenant',
    );
    throw new AppError(
      'TENANT_RESTRICTED',
      MESSAGE[phase] || 'La empresa no puede realizar esta operación',
      403,
    );
  }
}
