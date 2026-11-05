import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { RequestContextStore } from '../context/request-context';
import { AppPrismaService } from './app-prisma.service';
import { TENANT_SCOPED_MODELS } from './tenant-scoped-models';
import {
  setTransactionTenant,
  tenantFilterExtension,
  tenantSessionExtension,
  type TenantScopeOptions,
} from './tenant-scope/tenant-scope.extension';

/**
 * Punto de acceso a datos de tenant para los módulos de negocio (ADR-003).
 *  - `client`: operaciones individuales con filtro de aplicación + RLS (set_config por operación).
 *  - `transaction(fn)`: transacción interactiva con el tenant fijado al inicio.
 * El tenant sale del contexto del request (CLS), nunca de parámetros del cliente.
 */
@Injectable()
export class TenantDbService {
  private readonly options: TenantScopeOptions;
  private readonly filtered;
  readonly client;

  constructor(appPrisma: AppPrismaService, cls: ClsService<RequestContextStore>) {
    this.options = {
      tenantScopedModels: TENANT_SCOPED_MODELS,
      resolveTenantId: () => (cls.isActive() ? cls.get('tenantId') : undefined),
    };
    this.filtered = appPrisma.client.$extends(tenantFilterExtension(this.options));
    this.client = this.filtered.$extends(tenantSessionExtension(this.options));
  }

  transaction<T>(
    fn: (tx: Parameters<Parameters<typeof this.filtered.$transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return this.filtered.$transaction(async (tx) => {
      await setTransactionTenant(tx, this.options);
      return fn(tx);
    });
  }
}
