import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { BackofficePrismaService } from './backoffice-prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import { TenantLifecycleService } from './tenant-lifecycle.service';

export const TENANT_LIFECYCLE_QUEUE = 'tenant-lifecycle';
/** Cada 15 minutos: un vencimiento se aplica como mucho 15 minutos tarde (la matriz es por días). */
export const TENANT_LIFECYCLE_EVERY_MS = 15 * 60_000;

/**
 * Job de estados del tenant (Fase 4.3a; ADR-008): TRIAL → EXPIRED y PAST_DUE → SUSPENDED. Un único planificador
 * repetible (`upsertJobScheduler` es idempotente entre réplicas y reinicios); cada ejecución es idempotente.
 */
@Processor(TENANT_LIFECYCLE_QUEUE, { concurrency: 1 })
export class TenantLifecycleProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(TenantLifecycleProcessor.name);

  constructor(
    @InjectQueue(TENANT_LIFECYCLE_QUEUE) private readonly queue: Queue,
    private readonly lifecycle: TenantLifecycleService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'tenant-lifecycle-run-due',
      { every: TENANT_LIFECYCLE_EVERY_MS },
      { name: 'run-due', opts: { removeOnComplete: 100, removeOnFail: 500 } },
    );
  }

  async process(): Promise<{ applied: number }> {
    const applied = await this.lifecycle.runDue();
    if (applied > 0)
      this.logger.log({ event: 'tenant_lifecycle_applied', applied }, 'Transiciones aplicadas');
    return { applied };
  }
}

/**
 * Módulo del WORKER para el job de estados. No registra controladores: el worker solo expone su health interno.
 * Usa `yebo_backoffice` (sin BYPASSRLS), como el panel.
 */
@Module({
  imports: [BullModule.registerQueue({ name: TENANT_LIFECYCLE_QUEUE })],
  providers: [
    BackofficePrismaService,
    PlatformAuditService,
    TenantResolverService,
    TenantLifecycleService,
    TenantLifecycleProcessor,
  ],
})
export class TenantLifecycleWorkerModule {}
