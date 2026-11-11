import { Injectable } from '@nestjs/common';
import type { ChangePlanRequest, ChangePlanResponse } from '@yebo/contracts';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { Prisma } from '../../generated/prisma/client';
import { Clock } from '../identity/clock';
import { BackofficePrismaService } from './backoffice-prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import { ipOf, type PlatformPrincipal, type RequestMeta } from './platform-auth.service';

const UUID = z.uuid();
const INTERVAL_MONTHS = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 } as const;
type Interval = keyof typeof INTERVAL_MONTHS;

interface VersionTerms {
  base_price: Prisma.Decimal;
  included_users: number;
  billing_interval: Interval;
}

/**
 * Upgrade si la base mensual equivalente sube, o si es igual con más usuarios incluidos; si no, downgrade.
 */
export function isUpgrade(from: VersionTerms, to: VersionTerms): boolean {
  const monthly = (v: VersionTerms) =>
    new Prisma.Decimal(v.base_price).div(INTERVAL_MONTHS[v.billing_interval]);
  const a = monthly(from);
  const b = monthly(to);
  return b.gt(a) || (b.eq(a) && to.included_users > from.included_users);
}

/**
 * Cambio de plan de una empresa (decisión del responsable del 2026-11-10; billing §7 actualizado). En UNA transacción
 * con el contexto de la empresa:
 * - Upgrade: aplica HOY (día local de la empresa). Corta el período en curso (`cut_off` = hoy: se cerrará con la base
 *   prorrateada y los adicionales medidos hasta ayer), sustituye la suscripción vigente por otra con el plan nuevo
 *   que empieza hoy con su propio ciclo y abre su período. Módulos y límites cambian en la petición siguiente.
 * - Downgrade: se programa en la suscripción vigente y aplica al terminar su período.
 * La excepción comercial (`price_override`) es del plan anterior: no pasa a la suscripción nueva.
 */
@Injectable()
export class PlanChangeService {
  constructor(
    private readonly db: BackofficePrismaService,
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
  ) {}

  async change(
    actor: PlatformPrincipal,
    tenantId: string,
    input: ChangePlanRequest,
    meta: RequestMeta,
  ): Promise<ChangePlanResponse> {
    if (!UUID.safeParse(tenantId).success) throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
    const tenant = await this.db.client.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, timezone: true },
    });
    if (!tenant) throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
    if (!['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(tenant.status)) {
      throw new AppError('CONFLICT', 'La empresa no puede cambiar de plan en su estado actual', 409);
    }
    const now = this.clock.now();
    return this.db.withTenant(tenantId, async (tx) => {
      const [current] = await tx.$queryRaw<
        (VersionTerms & {
          id: string;
          plan_version_id: string;
          status: string;
          start: string;
          end: string;
          today: string;
        })[]
      >`
        SELECT s.id, s.plan_version_id, s.status::text AS status,
               to_char(s.current_period_start, 'YYYY-MM-DD') AS start, to_char(s.current_period_end, 'YYYY-MM-DD') AS end,
               pv.base_price, pv.included_users, pv.billing_interval::text AS billing_interval,
               to_char((${now}::timestamptz AT TIME ZONE ${tenant.timezone})::date, 'YYYY-MM-DD') AS today
          FROM subscriptions s JOIN plan_versions pv ON pv.id = s.plan_version_id
         WHERE s.is_current FOR UPDATE OF s`;
      if (!current) throw new AppError('CONFLICT', 'La empresa no tiene suscripción vigente', 409);
      const [target] = await tx.$queryRaw<(VersionTerms & { status: string })[]>`
        SELECT status::text AS status, base_price, included_users, billing_interval::text AS billing_interval
          FROM plan_versions WHERE id = ${input.planVersionId}::uuid FOR SHARE`;
      if (!target) throw new AppError('VALIDATION_FAILED', 'La versión de plan no existe', 400);
      if (target.status !== 'PUBLISHED') {
        throw new AppError('CONFLICT', 'Solo se puede contratar una versión de plan publicada', 409);
      }
      if (input.planVersionId === current.plan_version_id) {
        throw new AppError('CONFLICT', 'La empresa ya tiene esa versión de plan', 409);
      }
      const upgrade = isUpgrade(current, target);
      let effectiveOn: string;
      if (upgrade) {
        if (current.today >= current.end) {
          throw new AppError(
            'CONFLICT',
            'El período anterior aún no se ha cerrado; inténtalo en unos minutos',
            409,
          );
        }
        effectiveOn = current.today;
        // El período en curso (lo crea si el job aún no lo abrió) se corta hoy.
        await tx.$executeRaw`
          INSERT INTO billing_periods (tenant_id, subscription_id, period_start, period_end, timezone, is_trial)
          VALUES (${tenantId}::uuid, ${current.id}::uuid, ${current.start}::date, ${current.end}::date,
                  ${tenant.timezone}, ${current.status === 'TRIALING'})
          ON CONFLICT (subscription_id, period_start) DO NOTHING`;
        const cut = await tx.$executeRaw`
          UPDATE billing_periods SET cut_off = ${effectiveOn}::date
           WHERE subscription_id = ${current.id}::uuid AND period_start = ${current.start}::date
             AND status = 'OPEN' AND cut_off IS NULL`;
        if (cut !== 1) throw new AppError('CONFLICT', 'El período en curso ya no admite cambios', 409);
        await tx.$executeRaw`
          UPDATE subscriptions SET is_current = NULL, next_plan_version_id = NULL, updated_at = now()
           WHERE id = ${current.id}::uuid`;
        const [created] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO subscriptions (id, tenant_id, plan_version_id, status, current_period_start, current_period_end,
                                     is_current, updated_at)
          VALUES (gen_random_uuid(), ${tenantId}::uuid, ${input.planVersionId}::uuid,
                  ${current.status}::subscription_status, ${effectiveOn}::date,
                  (${effectiveOn}::date + make_interval(months => ${INTERVAL_MONTHS[target.billing_interval]}::int))::date,
                  true, now())
          RETURNING id`;
        await tx.$executeRaw`
          INSERT INTO billing_periods (tenant_id, subscription_id, period_start, period_end, timezone, is_trial)
          SELECT tenant_id, id, current_period_start, current_period_end, ${tenant.timezone}, status = 'TRIALING'
            FROM subscriptions WHERE id = ${created?.id}::uuid`;
      } else {
        effectiveOn = current.end;
        await tx.$executeRaw`
          UPDATE subscriptions SET next_plan_version_id = ${input.planVersionId}::uuid, updated_at = now()
           WHERE id = ${current.id}::uuid`;
      }
      const kind = upgrade ? 'UPGRADE' : 'DOWNGRADE';
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'subscription.plan_changed',
          targetType: 'subscription',
          targetId: current.id,
          tenantId,
          detail: {
            kind,
            from: current.plan_version_id,
            to: input.planVersionId,
            effectiveOn,
            reason: input.reason,
          },
          ...ipOf(meta),
        },
        tx,
      );
      return { kind, effectiveOn };
    });
  }
}
