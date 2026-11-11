import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { MeteringPrismaService } from './metering-prisma.service';
import { MeteringService } from './metering.service';
import { PeriodClosingService } from './period-closing.service';

export const USAGE_METERING_QUEUE = 'usage-metering';
/** Cada hora (billing §4): un día se cierra como mucho una hora y cuarto después de terminar. */
export const USAGE_METERING_EVERY_MS = 60 * 60_000;

/** Job horario de snapshots (Fase 4.4) y cierre de períodos (Fase 4.5); ADR-008. Planificador único entre réplicas; ejecución idempotente. */
@Processor(USAGE_METERING_QUEUE, { concurrency: 1 })
export class UsageMeteringProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(UsageMeteringProcessor.name);

  constructor(
    @InjectQueue(USAGE_METERING_QUEUE) private readonly queue: Queue,
    private readonly metering: MeteringService,
    private readonly periods: PeriodClosingService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'usage-metering-run-due',
      { every: USAGE_METERING_EVERY_MS },
      { name: 'run-due', opts: { removeOnComplete: 100, removeOnFail: 500 } },
    );
  }

  /** Primero los snapshots de los días terminados; después, el cierre de los períodos vencidos (Fase 4.5). */
  async process(): Promise<{ created: number; closed: number }> {
    const created = await this.metering.runDue();
    if (created > 0)
      this.logger.log({ event: 'usage_snapshots_created', created }, 'Snapshots diarios creados');
    const closed = await this.periods.runDue();
    if (closed > 0) this.logger.log({ event: 'billing_periods_closed', closed }, 'Períodos cerrados');
    return { created, closed };
  }
}

/** Módulo del WORKER para la medición: sin controladores; rol `yebo_metering`. */
@Module({
  imports: [BullModule.registerQueue({ name: USAGE_METERING_QUEUE })],
  providers: [MeteringPrismaService, MeteringService, PeriodClosingService, UsageMeteringProcessor],
  exports: [MeteringService, PeriodClosingService],
})
export class MeteringWorkerModule {}
