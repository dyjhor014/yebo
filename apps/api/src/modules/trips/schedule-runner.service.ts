import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantDirectoryService } from '../tenancy/tenant-directory.service';
import { SchedulesService } from './schedules.service';

export type ScheduleRunSummary = { tenants: number; schedules: number; created: number; failed: number };

/**
 * Generación de viajes de todas las empresas operativas (TRIAL, ACTIVE y PAST_DUE: las que pueden hacer operaciones
 * comerciales nuevas). Cada empresa corre con su tenant y su zona horaria en el contexto, con `yebo_app` y RLS. Un error
 * en una programación se registra y no detiene las demás. Idempotente: se puede ejecutar cuantas veces haga falta.
 */
@Injectable()
export class ScheduleRunnerService {
  private readonly logger = new Logger(ScheduleRunnerService.name);

  constructor(
    private readonly directory: TenantDirectoryService,
    private readonly schedules: SchedulesService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  async runDue(): Promise<ScheduleRunSummary> {
    const summary: ScheduleRunSummary = { tenants: 0, schedules: 0, created: 0, failed: 0 };
    for (const tenant of await this.directory.operative()) {
      summary.tenants += 1;
      await this.cls.run(async () => {
        this.cls.set('tenantId', tenant.id);
        this.cls.set('tenant', tenant);
        for (const id of await this.schedules.activeIds()) {
          summary.schedules += 1;
          try {
            summary.created += (await this.schedules.generate(id)).created.length;
          } catch (error) {
            summary.failed += 1;
            this.logger.error(
              { event: 'schedule_generation_failed', tenantId: tenant.id, scheduleId: id, err: error },
              'No se pudieron generar los viajes de una programación',
            );
          }
        }
      });
    }
    return summary;
  }
}
