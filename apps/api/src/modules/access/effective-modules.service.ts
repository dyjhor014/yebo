import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '../../generated/prisma/client';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { Clock } from '../identity/clock';
import { SERVICE_OF_MODULE } from './module-catalog';

/** Pares (módulo, servicio) como tabla de valores para la consulta; fuente: module-catalog.ts. */
const SERVICE_MODULES = Prisma.join(
  Object.entries(SERVICE_OF_MODULE).map(([code, service]) => Prisma.sql`(${code}, ${service})`),
);

/**
 * Módulos efectivos del tenant del contexto (multitenancy §6; Fase 4.2):
 *
 *   efectivos = ((módulos de la versión de plan de la suscripción vigente ∩ servicios de la empresa)
 *                ∪ excepciones GRANT vigentes) − excepciones REVOKE vigentes
 *
 * Una excepción REVOKE gana sobre una GRANT. Solo cuentan los módulos activos del catálogo. «∩ servicios» (4.3a):
 * un módulo de servicio (SERVICE_OF_MODULE) del plan solo cuenta si la empresa tiene ese servicio habilitado en
 * alguna modalidad (`tenant_services`); los demás módulos del plan no dependen de los servicios. Una GRANT no exige
 * el servicio: es una decisión expresa de YEBO.
 * Una sola consulta con `yebo_app` en el contexto del tenant (RLS en suscripciones y excepciones), una vez por request.
 */
@Injectable()
export class EffectiveModulesService {
  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly clock: Clock,
  ) {}

  async current(): Promise<ReadonlySet<string>> {
    const cached = this.cls.get('modules');
    if (cached) return cached;
    const modules = await this.compute(this.clock.now());
    this.cls.set('modules', modules);
    return modules;
  }

  async compute(now: Date): Promise<ReadonlySet<string>> {
    const rows = await this.db.transaction(
      (tx) => tx.$queryRaw<{ code: string }[]>`
        WITH plan_modules AS (
          SELECT m.code FROM subscriptions s
            JOIN plan_version_modules pvm ON pvm.plan_version_id = s.plan_version_id
            JOIN modules m ON m.id = pvm.module_id
            LEFT JOIN (VALUES ${SERVICE_MODULES}) AS sm(code, service) ON sm.code = m.code
           WHERE s.is_current AND m.is_active
             AND (sm.service IS NULL OR EXISTS (
                   SELECT 1 FROM tenant_services ts WHERE ts.enabled AND ts.service::text = sm.service))
        ), active_overrides AS (
          SELECT o.effect, m.code FROM tenant_module_overrides o
            JOIN modules m ON m.id = o.module_id
           WHERE m.is_active AND o.ended_at IS NULL
             AND o.valid_from <= ${now} AND (o.valid_to IS NULL OR o.valid_to > ${now})
        )
        SELECT code FROM plan_modules
        UNION SELECT code FROM active_overrides WHERE effect = 'GRANT'
        EXCEPT SELECT code FROM active_overrides WHERE effect = 'REVOKE'`,
    );
    return new Set(rows.map((r) => r.code));
  }
}
