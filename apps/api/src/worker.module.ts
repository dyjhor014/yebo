import { Module } from '@nestjs/common';
import { CoreModule } from './infrastructure/core.module';
import { HealthModule } from './modules/health/health.module';

/**
 * Proceso worker (BullMQ). Expone solo health interno.
 * Los procesadores (outbox relay, notificaciones, facturación, expiraciones) se registran en sus fases.
 */
@Module({
  imports: [CoreModule, HealthModule.forService('worker')],
})
export class WorkerModule {}
