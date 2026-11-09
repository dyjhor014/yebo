import { Injectable } from '@nestjs/common';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import type { TenantOperationCategory } from './tenant-operation';

/** Categorías que admiten una excepción temporal de YEBO (multitenancy §5.2, nota 2; tabla `tenant_operation_overrides`). */
const OVERRIDABLE: ReadonlySet<TenantOperationCategory> = new Set(['USERS_ADD']);

/**
 * Excepciones de operación vigentes del tenant del contexto (Fase 4.3a). Solo se consultan cuando la matriz ya ha
 * denegado, así que no añaden coste a las peticiones permitidas. Lectura con `yebo_app` y RLS.
 */
@Injectable()
export class OperationOverridesService {
  constructor(private readonly db: TenantDbService) {}

  async isGranted(category: TenantOperationCategory, now: Date): Promise<boolean> {
    if (!OVERRIDABLE.has(category)) return false;
    const rows = await this.db.transaction(
      (tx) => tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM tenant_operation_overrides
         WHERE category::text = ${category} AND ended_at IS NULL
           AND valid_from <= ${now} AND valid_to > ${now}
         LIMIT 1`,
    );
    return rows.length > 0;
  }
}
