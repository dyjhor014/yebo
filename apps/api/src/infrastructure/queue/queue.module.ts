import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';
import { buildQueueConnection } from './queue-connection';

/**
 * Configuración raíz de BullMQ (ADR-008). Las colas concretas (outbox, notificaciones,
 * facturación electrónica) se registran en sus módulos a partir de las fases correspondientes.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ connection: buildQueueConnection(env), prefix: env.BULLMQ_PREFIX }),
    }),
  ],
})
export class QueueModule {}
