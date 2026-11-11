import { Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../../common/errors/app-error';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { Clock } from '../../identity/clock';
import { OperationOverridesService } from '../operation-overrides.service';
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
    private readonly overrides: OperationOverridesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = routePolicyForContext(this.reflector, context);
    if (policy.kind !== 'protected') return true;
    const tenant = this.cls.get('tenant');
    if (!tenant) throw new Error('TenantHostGuard no fijó el tenant antes de TenantStatusGuard');
    const now = this.clock.now();
    const phase = tenantPhase(tenant, now);
    if (isOperationAllowed(policy.operation, phase)) return true;
    // Excepción temporal de YEBO (multitenancy §5.2, nota 2): solo en SUSPENDED y EXPIRED, nunca en CANCELLED.
    if (
      (phase === 'SUSPENDED' || phase === 'EXPIRED') &&
      (await this.overrides.isGranted(policy.operation, now))
    ) {
      this.logger.log(
        { event: 'tenant_operation_override_used', tenantId: tenant.id, phase, category: policy.operation },
        'Operación permitida por una excepción de YEBO',
      );
      return true;
    }
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
