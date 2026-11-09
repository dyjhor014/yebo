import { Module } from '@nestjs/common';
import { CoreModule } from './infrastructure/core.module';
import { HealthModule } from './modules/health/health.module';
import { ClockModule } from './modules/identity/clock.module';
import { MeteringWorkerModule } from './modules/metering/metering.worker';
import { TenantLifecycleWorkerModule } from './modules/platform-admin/tenant-lifecycle.worker';

/**
 * Proceso worker (BullMQ). Expone solo health interno.
 * Los procesadores (outbox relay, notificaciones, facturación, expiraciones) se registran en sus fases.
 * Fase 4.3a: job de estados del tenant. Fase 4.4: job de snapshots diarios de medición.
 */
@Module({
  imports: [
    CoreModule,
    ClockModule,
    HealthModule.forService('worker'),
    TenantLifecycleWorkerModule,
    MeteringWorkerModule,
  ],
})
export class WorkerModule {}
