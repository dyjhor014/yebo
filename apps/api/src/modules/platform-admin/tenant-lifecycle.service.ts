import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import type { Prisma, TenantStatus } from '../../generated/prisma/client';
import { Clock } from '../identity/clock';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { BackofficePrismaService } from './backoffice-prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import {
  AUTOMATIC_REASON,
  SUBSCRIPTION_STATUS_FOR,
  dueTransition,
  isManualTransitionAllowed,
} from './tenant-lifecycle';

export interface TransitionRequest {
  tenantId: string;
  to: TenantStatus;
  reason: string;
  /** `null` = job de estados. */
  actorPlatformUserId: string | null;
  ip?: string;
  /**
   * Solo para el job: la transición se aplica si el tenant SIGUE en el estado que se evaluó y desde el mismo
   * instante (otro proceso o el staff pudo cambiarlo mientras tanto).
   */
  expect?: { status: TenantStatus; statusChangedAt: Date };
}

/**
 * Transiciones del tenant (Fase 4.3a). En UNA transacción y con el tenant bloqueado: estado del tenant, estado de la
 * suscripción vigente, fila de `tenant_status_history` y auditoría. Después del commit se invalida la caché del
 * resolvedor para todos sus dominios, así que la matriz de estados aplica el estado nuevo en la siguiente petición.
 */
@Injectable()
export class TenantLifecycleService {
  private readonly logger = new Logger(TenantLifecycleService.name);

  constructor(
    private readonly db: BackofficePrismaService,
    private readonly audit: PlatformAuditService,
    private readonly resolver: TenantResolverService,
    private readonly clock: Clock,
  ) {}

  /** Devuelve `false` si `expect` ya no se cumple (el job lo omite sin error). */
  async transition(req: TransitionRequest): Promise<boolean> {
    const applied = await this.db.client.$transaction((tx) => this.applyIn(tx, req));
    if (applied) await this.invalidate(req.tenantId);
    return applied;
  }

  /**
   * La transición DENTRO de una transacción ya abierta (p. ej., el registro de un pago que reactiva la empresa).
   * Quien llama invalida la caché del resolvedor después del commit (`invalidate`).
   */
  async applyIn(tx: Prisma.TransactionClient, req: TransitionRequest): Promise<boolean> {
    const now = this.clock.now();
    {
      const [row] = await tx.$queryRaw<{ status: TenantStatus; status_changed_at: Date }[]>`
        SELECT status::text AS status, status_changed_at FROM tenants WHERE id = ${req.tenantId}::uuid FOR UPDATE`;
      if (!row) throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
      if (req.expect) {
        if (
          row.status !== req.expect.status ||
          row.status_changed_at.getTime() !== req.expect.statusChangedAt.getTime()
        ) {
          return false;
        }
      } else if (!isManualTransitionAllowed(row.status, req.to)) {
        throw new AppError('CONFLICT', `Transición no permitida: ${row.status} → ${req.to}`, 409);
      }
      await tx.tenant.update({
        where: { id: req.tenantId },
        data: {
          status: req.to,
          statusChangedAt: now,
          ...(req.to === 'ACTIVE' ? { activatedAt: now } : {}),
          ...(req.to === 'CANCELLED' ? { cancelledAt: now } : {}),
        },
        select: { id: true },
      });
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${req.tenantId}, true)`;
      await tx.subscription.updateMany({
        where: { tenantId: req.tenantId, isCurrent: true },
        data: { status: SUBSCRIPTION_STATUS_FOR[req.to] },
      });
      await tx.tenantStatusHistory.create({
        data: {
          tenantId: req.tenantId,
          fromStatus: row.status,
          toStatus: req.to,
          reason: req.reason,
          actorPlatformUserId: req.actorPlatformUserId,
          occurredAt: now,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          platformUserId: req.actorPlatformUserId,
          action: 'tenant.status_changed',
          targetType: 'tenant',
          targetId: req.tenantId,
          tenantId: req.tenantId,
          detail: { from: row.status, to: req.to, reason: req.reason, automatic: !!req.expect },
          ...(req.ip ? { ip: req.ip } : {}),
        },
        tx,
      );
      return true;
    }
  }

  /**
   * Job de estados: aplica las transiciones automáticas vencidas en `now`. Idempotente (cada transición vuelve a
   * comprobarse con el tenant bloqueado). Devuelve cuántas aplicó.
   */
  async runDue(): Promise<number> {
    const now = this.clock.now();
    let applied = await this.markOverdue(now);
    const candidates = await this.db.client.tenant.findMany({
      where: {
        OR: [
          { status: 'TRIAL', trialEndsAt: { lte: now } },
          { status: 'PAST_DUE', statusChangedAt: { lte: now } },
        ],
      },
      select: { id: true, status: true, statusChangedAt: true, trialEndsAt: true },
    });
    for (const c of candidates) {
      const pastDueGraceDays = c.status === 'PAST_DUE' ? await this.graceDays(c.id) : null;
      const to = dueTransition({ ...c, pastDueGraceDays }, now);
      if (!to) continue;
      try {
        const done = await this.transition({
          tenantId: c.id,
          to,
          reason: AUTOMATIC_REASON[to] ?? 'Transición automática',
          actorPlatformUserId: null,
          expect: { status: c.status, statusChangedAt: c.statusChangedAt },
        });
        if (done) applied += 1;
      } catch (error) {
        // Un tenant problemático no detiene a los demás; el siguiente ciclo lo reintenta.
        this.logger.error({ err: error, tenantId: c.id, to }, 'No se pudo aplicar la transición automática');
      }
    }
    return applied;
  }

  /**
   * Facturas vencidas (Fase 4.5): las emitidas o parciales con saldo y fecha de vencimiento ya pasada en la zona de
   * la empresa pasan a OVERDUE; una empresa ACTIVE con una factura vencida pasa a PAST_DUE (multitenancy §5.2).
   */
  private async markOverdue(now: Date): Promise<number> {
    const tenants = await this.db.client.tenant.findMany({
      select: { id: true, status: true, statusChangedAt: true, timezone: true },
    });
    let applied = 0;
    for (const t of tenants) {
      try {
        const overdue = await this.db.withTenant(t.id, async (tx) => {
          await tx.$executeRaw`
            UPDATE platform_invoices SET status = 'OVERDUE', updated_at = now()
             WHERE status IN ('ISSUED', 'PARTIALLY_PAID') AND balance > 0
               AND due_date < (${now}::timestamptz AT TIME ZONE ${t.timezone})::date`;
          const [row] = await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM platform_invoices WHERE status = 'OVERDUE' AND balance > 0`;
          return (row?.n ?? 0) > 0;
        });
        if (overdue && t.status === 'ACTIVE') {
          const done = await this.transition({
            tenantId: t.id,
            to: 'PAST_DUE',
            reason: AUTOMATIC_REASON.PAST_DUE ?? 'Factura vencida',
            actorPlatformUserId: null,
            expect: { status: t.status, statusChangedAt: t.statusChangedAt },
          });
          if (done) applied += 1;
        }
      } catch (error) {
        this.logger.error({ err: error, tenantId: t.id }, 'No se pudieron revisar sus facturas vencidas');
      }
    }
    return applied;
  }

  /** Días de gracia de la versión de plan de la suscripción vigente (`null` = por defecto). */
  private async graceDays(tenantId: string): Promise<number | null> {
    const rows = await this.db.withTenant(
      tenantId,
      (tx) => tx.$queryRaw<{ days: number | null }[]>`
        SELECT (pv.suspension_policy ->> 'pastDueGraceDays')::int AS days
          FROM subscriptions s JOIN plan_versions pv ON pv.id = s.plan_version_id
         WHERE s.is_current`,
    );
    return rows[0]?.days ?? null;
  }

  async invalidate(tenantId: string): Promise<void> {
    const domains = await this.db.client.tenantDomain.findMany({
      where: { tenantId },
      select: { host: true },
    });
    await Promise.all(domains.map((d) => this.resolver.invalidate(d.host)));
  }
}
