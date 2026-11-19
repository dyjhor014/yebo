import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { FleetContext } from '../fleet/fleet-context';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ScheduleRunnerService, type ScheduleRunSummary } from './schedule-runner.service';
import { SchedulesService } from './schedules.service';
import { TripsService } from './trips.service';

export const TRIP_SCHEDULES_QUEUE = 'trip-schedules';
/** Todos los días a las 00:30 de Lima (F7-Q2: job diario). Cada ejecución es idempotente. */
export const TRIP_SCHEDULES_CRON = { pattern: '30 0 * * *', tz: 'America/Lima' } as const;

/**
 * Job de programaciones (Fase 7.3b; F7-Q2): genera los viajes que faltan hasta el horizonte en todas las empresas
 * operativas. Un único planificador repetible (`upsertJobScheduler` es idempotente entre réplicas y reinicios).
 */
@Processor(TRIP_SCHEDULES_QUEUE, { concurrency: 1 })
export class TripSchedulesProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(TripSchedulesProcessor.name);

  constructor(
    @InjectQueue(TRIP_SCHEDULES_QUEUE) private readonly queue: Queue,
    private readonly runner: ScheduleRunnerService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler('trip-schedules-generate', TRIP_SCHEDULES_CRON, {
      name: 'generate',
      opts: { removeOnComplete: 100, removeOnFail: 500 },
    });
  }

  async process(): Promise<ScheduleRunSummary> {
    const summary = await this.runner.runDue();
    this.logger.log({ event: 'trip_schedules_generated', ...summary }, 'Programaciones generadas');
    return summary;
  }
}

/** Módulo del WORKER para el job de programaciones. Sin controladores: el worker solo expone su health interno. */
@Module({
  imports: [BullModule.registerQueue({ name: TRIP_SCHEDULES_QUEUE }), TenancyModule],
  providers: [FleetContext, TripsService, SchedulesService, ScheduleRunnerService, TripSchedulesProcessor],
})
export class TripSchedulesWorkerModule {}
