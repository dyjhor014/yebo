import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateTenantRequest,
  CreateTenantResponse,
  InvitationLink,
  OperationOverride,
  OperationOverrideInput,
  TenantDetail,
  TenantSummary,
  TenantUsageResponse,
} from '@yebo/contracts';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';
import { Prisma } from '../../generated/prisma/client';
import { Clock } from '../identity/clock';
import { INVITATION_TTL_MS, invitationLink, newInvitationToken } from '../identity/invitation-token';
import { computeUsageDay, minActiveSecondsOf } from '../metering/usage-calculation';
import { isReservedSlug } from '../tenancy/reserved-subdomains';
import { BackofficePrismaService } from './backoffice-prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import { ipOf, type PlatformPrincipal, type RequestMeta } from './platform-auth.service';
import { SUBSCRIPTION_STATUS_FOR } from './tenant-lifecycle';
import { TenantLifecycleService } from './tenant-lifecycle.service';

const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
const INTERVAL_MONTHS = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 } as const;

/**
 * Empresas en el panel de YEBO (Fase 4.3a): alta, ficha, estados y excepciones de operación.
 *
 * El alta es UNA transacción con `yebo_backoffice`: el tenant y su subdominio por defecto (verificado), y después,
 * con el contexto del tenant fijado (RLS), su configuración, sus servicios, los roles de sistema desde las
 * plantillas, la suscripción a una versión de plan publicada y la primera fila del historial de estados. Si algo
 * falla, no queda nada a medias.
 */
@Injectable()
export class TenantsService {
  constructor(
    private readonly db: BackofficePrismaService,
    private readonly audit: PlatformAuditService,
    private readonly lifecycle: TenantLifecycleService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async create(
    actor: PlatformPrincipal,
    input: CreateTenantRequest,
    meta: RequestMeta,
  ): Promise<CreateTenantResponse> {
    if (
      isReservedSlug(
        input.slug,
        [this.env.AUTH_HUB_HOST, this.env.PLATFORM_ADMIN_HOST],
        this.env.TENANT_BASE_DOMAIN,
      )
    ) {
      throw new AppError('VALIDATION_FAILED', 'Ese subdominio está reservado por YEBO', 400);
    }
    const host = `${input.slug}.${this.env.TENANT_BASE_DOMAIN}`;
    const now = this.clock.now();
    let tenantId: string;
    let firstAdminInvitation: InvitationLink | null = null;
    try {
      tenantId = await this.db.client.$transaction(async (tx) => {
        // FOR SHARE: una retirada simultánea de la versión espera a que termine el alta.
        const [version] = await tx.$queryRaw<
          { status: string; trial_days: number; billing_interval: keyof typeof INTERVAL_MONTHS }[]
        >`SELECT status::text AS status, trial_days, billing_interval::text AS billing_interval
            FROM plan_versions WHERE id = ${input.planVersionId}::uuid FOR SHARE`;
        if (!version) throw new AppError('VALIDATION_FAILED', 'La versión de plan no existe', 400);
        if (version.status !== 'PUBLISHED') {
          throw new AppError('CONFLICT', 'Solo se puede contratar una versión de plan publicada', 409);
        }
        const conflict = await tx.tenant.findFirst({
          where: { OR: [{ slug: input.slug }, { taxIdType: input.taxIdType, taxId: input.taxId }] },
          select: { slug: true },
        });
        if (conflict) {
          throw new AppError(
            'CONFLICT',
            conflict.slug === input.slug
              ? 'Ese subdominio ya está en uso'
              : 'Ya existe una empresa con ese documento',
            409,
          );
        }
        const trial = version.trial_days > 0;
        const status = trial ? 'TRIAL' : 'ACTIVE';
        const tenant = await tx.tenant.create({
          data: {
            slug: input.slug,
            legalName: input.legalName,
            tradeName: input.tradeName,
            taxIdType: input.taxIdType,
            taxId: input.taxId,
            timezone: input.timezone,
            status,
            statusChangedAt: now,
            trialEndsAt: trial ? new Date(now.getTime() + version.trial_days * 86_400_000) : null,
            activatedAt: trial ? null : now,
          },
          select: { id: true },
        });
        await tx.tenantDomain.create({
          data: {
            tenantId: tenant.id,
            host,
            kind: 'SUBDOMAIN',
            isPrimary: true,
            verificationStatus: 'VERIFIED',
            verifiedAt: now,
          },
          select: { id: true },
        });

        // Datos de tenant: contexto fijado en ESTA transacción (ADR-025); el RLS forzado sigue activo.
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
        await tx.tenantSetting.create({ data: { tenantId: tenant.id }, select: { tenantId: true } });
        await tx.tenantService.createMany({
          data: input.services.map((s) => ({
            tenantId: tenant.id,
            modality: s.modality,
            service: s.service,
          })),
        });
        const roles = await this.instantiateRoles(tx, tenant.id);
        // Período en la zona horaria de la empresa; PostgreSQL ajusta fin de mes (31 ene + 1 mes = 28/29 feb).
        const [period] = await tx.$queryRaw<{ start: Date; end: Date }[]>`
          SELECT (${now}::timestamptz AT TIME ZONE ${input.timezone})::date AS start,
                 ((${now}::timestamptz AT TIME ZONE ${input.timezone})::date
                   + make_interval(months => ${INTERVAL_MONTHS[version.billing_interval]}::int))::date AS end`;
        if (!period) throw new Error('No se pudo calcular el período');
        await tx.subscription.create({
          data: {
            tenantId: tenant.id,
            planVersionId: input.planVersionId,
            status: SUBSCRIPTION_STATUS_FOR[status],
            currentPeriodStart: period.start,
            currentPeriodEnd: period.end,
            isCurrent: true,
          },
          select: { id: true },
        });
        await tx.tenantStatusHistory.create({
          data: {
            tenantId: tenant.id,
            fromStatus: null,
            toStatus: status,
            reason: 'Alta de la empresa',
            actorPlatformUserId: actor.platformUserId,
            occurredAt: now,
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            platformUserId: actor.platformUserId,
            action: 'tenant.created',
            targetType: 'tenant',
            targetId: tenant.id,
            tenantId: tenant.id,
            detail: { slug: input.slug, host, planVersionId: input.planVersionId, status },
            ...ipOf(meta),
          },
          tx,
        );
        if (input.firstAdminEmail) {
          const adminRole = roles.get('ADMIN');
          if (!adminRole) throw new Error('Falta la plantilla ADMIN en role_templates');
          firstAdminInvitation = await this.invite(
            tx,
            actor,
            tenant.id,
            input.firstAdminEmail,
            [adminRole],
            now,
            meta,
          );
        }
        return tenant.id;
      });
    } catch (error) {
      // Carrera con otra alta del mismo slug, host o documento: la restricción única decide.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError('CONFLICT', 'El subdominio o el documento ya están en uso', 409);
      }
      throw error;
    }
    // El resolvedor pudo cachear el host como inexistente (caché negativa): se invalida para que resuelva ya.
    await this.lifecycle.invalidate(tenantId);
    return { ...(await this.get(tenantId)), firstAdminInvitation };
  }

  /**
   * Invitación a una empresa desde el panel (Fase 4.3b), con roles elegidos de esa empresa (no archivados). El
   * enlace se devuelve una vez. La valida el mismo hub que las invitaciones de la propia empresa.
   */
  async inviteToTenant(
    actor: PlatformPrincipal,
    tenantId: string,
    email: string,
    roleIds: readonly string[],
    meta: RequestMeta,
  ): Promise<InvitationLink> {
    await this.requireTenant(tenantId);
    const now = this.clock.now();
    return this.db.withTenant(tenantId, async (tx) => {
      const roles = await tx.role.findMany({
        where: { id: { in: [...roleIds] }, archivedAt: null },
        select: { id: true },
      });
      if (roles.length !== roleIds.length) {
        throw new AppError('VALIDATION_FAILED', 'Algún rol no existe en esta empresa', 400);
      }
      return this.invite(tx, actor, tenantId, email, [...roleIds], now, meta);
    });
  }

  /**
   * Consumo diario (Fase 4.4; billing §4): los días cerrados salen de los snapshots FINAL y, si el rango incluye el
   * día en curso de la empresa, se calcula al vuelo como PROVISIONAL (sin guardarlo). Como mucho 93 días.
   */
  async usage(tenantId: string, from: string, to: string): Promise<TenantUsageResponse> {
    await this.requireTenant(tenantId);
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 92) {
      throw new AppError('VALIDATION_FAILED', 'Consulta como mucho 93 días', 400);
    }
    const tenant = await this.db.client.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { timezone: true },
    });
    const now = this.clock.now();
    return this.db.withTenant(tenantId, async (tx) => {
      const finals = await tx.$queryRaw<{ d: string; peak: number; distinct_active: number }[]>`
        SELECT to_char(usage_date, 'YYYY-MM-DD') AS d, peak_concurrent AS peak, distinct_active
          FROM usage_daily_snapshots WHERE usage_date BETWEEN ${from}::date AND ${to}::date ORDER BY usage_date`;
      const days: TenantUsageResponse['days'] = finals.map((f) => ({
        date: f.d,
        peakConcurrent: f.peak,
        distinctActive: f.distinct_active,
        status: 'FINAL',
      }));
      const [today] = await tx.$queryRaw<{ d: string }[]>`
        SELECT to_char((${now}::timestamptz AT TIME ZONE ${tenant.timezone})::date, 'YYYY-MM-DD') AS d`;
      if (today && today.d >= from && today.d <= to && !days.some((x) => x.date === today.d)) {
        const day = await computeUsageDay(tx, {
          tenantId,
          date: today.d,
          timezone: tenant.timezone,
          minActiveSeconds: await minActiveSecondsOf(tx),
        });
        days.push({
          date: today.d,
          peakConcurrent: day.peakConcurrent,
          distinctActive: day.distinctActive,
          status: 'PROVISIONAL',
        });
      }
      return { timezone: tenant.timezone, days };
    });
  }

  /** Roles de una empresa (para el selector de la invitación). */
  async listRoles(tenantId: string): Promise<{ id: string; name: string; isSystem: boolean }[]> {
    await this.requireTenant(tenantId);
    return this.db.withTenant(tenantId, (tx) =>
      tx.role.findMany({
        where: { archivedAt: null },
        select: { id: true, name: true, isSystem: true },
        orderBy: { name: 'asc' },
      }),
    );
  }

  async list(): Promise<TenantSummary[]> {
    const rows = await this.db.client.tenant.findMany({
      select: {
        id: true,
        slug: true,
        tradeName: true,
        legalName: true,
        status: true,
        createdAt: true,
        domains: { where: { isPrimary: true }, select: { host: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((t) => ({
      id: t.id,
      slug: t.slug,
      tradeName: t.tradeName,
      legalName: t.legalName,
      status: t.status,
      primaryHost: t.domains[0]?.host ?? null,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  async get(tenantId: string): Promise<TenantDetail> {
    if (!UUID.safeParse(tenantId).success) throw NOT_FOUND();
    const t = await this.db.client.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        slug: true,
        tradeName: true,
        legalName: true,
        status: true,
        createdAt: true,
        taxIdType: true,
        taxId: true,
        timezone: true,
        trialEndsAt: true,
        activatedAt: true,
        cancelledAt: true,
        statusChangedAt: true,
        domains: {
          select: { host: true, kind: true, isPrimary: true, verificationStatus: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!t) throw NOT_FOUND();
    const scoped = await this.db.withTenant(tenantId, async (tx) => ({
      services: await tx.tenantService.findMany({
        select: { modality: true, service: true, enabled: true },
        orderBy: [{ modality: 'asc' }, { service: 'asc' }],
      }),
      subscription: await tx.subscription.findFirst({
        where: { isCurrent: true },
        select: {
          id: true,
          planVersionId: true,
          status: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
        },
      }),
      history: await tx.tenantStatusHistory.findMany({
        select: {
          fromStatus: true,
          toStatus: true,
          reason: true,
          actorPlatformUserId: true,
          occurredAt: true,
        },
        orderBy: { occurredAt: 'asc' },
      }),
    }));
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    const day = (d: Date) => d.toISOString().slice(0, 10);
    return {
      id: t.id,
      slug: t.slug,
      tradeName: t.tradeName,
      legalName: t.legalName,
      status: t.status,
      primaryHost: t.domains.find((d) => d.isPrimary)?.host ?? null,
      createdAt: t.createdAt.toISOString(),
      taxIdType: t.taxIdType,
      taxId: t.taxId,
      timezone: t.timezone,
      trialEndsAt: iso(t.trialEndsAt),
      activatedAt: iso(t.activatedAt),
      cancelledAt: iso(t.cancelledAt),
      statusChangedAt: t.statusChangedAt.toISOString(),
      domains: t.domains.map((d) => ({ ...d, isPrimary: d.isPrimary === true })),
      services: scoped.services,
      subscription: scoped.subscription
        ? {
            ...scoped.subscription,
            currentPeriodStart: day(scoped.subscription.currentPeriodStart),
            currentPeriodEnd: day(scoped.subscription.currentPeriodEnd),
          }
        : null,
      statusHistory: scoped.history.map((h) => ({ ...h, occurredAt: h.occurredAt.toISOString() })),
    };
  }

  async changeStatus(
    actor: PlatformPrincipal,
    tenantId: string,
    input: { to: TenantDetail['status']; reason: string },
    meta: RequestMeta,
  ): Promise<TenantDetail> {
    if (!UUID.safeParse(tenantId).success) throw NOT_FOUND();
    await this.lifecycle.transition({
      tenantId,
      to: input.to,
      reason: input.reason,
      actorPlatformUserId: actor.platformUserId,
      ...ipOf(meta),
    });
    return this.get(tenantId);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Excepciones de operación (multitenancy §5.2, nota 2): hoy solo USERS_ADD
  // ---------------------------------------------------------------------------------------------------------------

  async listOperationOverrides(tenantId: string): Promise<OperationOverride[]> {
    await this.requireTenant(tenantId);
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.tenantOperationOverride.findMany({ select: OVERRIDE_SELECT, orderBy: { createdAt: 'desc' } }),
    );
    return rows.map(toOverride);
  }

  async createOperationOverride(
    actor: PlatformPrincipal,
    tenantId: string,
    input: OperationOverrideInput,
    meta: RequestMeta,
  ): Promise<OperationOverride> {
    await this.requireTenant(tenantId);
    const validFrom = input.validFrom ? new Date(input.validFrom) : this.clock.now();
    const validTo = new Date(input.validTo);
    if (validTo <= validFrom || validTo.getTime() - validFrom.getTime() > 30 * 86_400_000) {
      throw new AppError(
        'VALIDATION_FAILED',
        'La excepción debe terminar después de empezar y durar como mucho 30 días',
        400,
      );
    }
    return this.db.withTenant(tenantId, async (tx) => {
      const row = await tx.tenantOperationOverride.create({
        data: {
          tenantId,
          category: input.category,
          validFrom,
          validTo,
          reason: input.reason,
          grantedByPlatformUserId: actor.platformUserId,
        },
        select: OVERRIDE_SELECT,
      });
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'operation_override.created',
          targetType: 'tenant_operation_override',
          targetId: row.id,
          tenantId,
          detail: { category: input.category, reason: input.reason, validTo: validTo.toISOString() },
          ...ipOf(meta),
        },
        tx,
      );
      return toOverride(row);
    });
  }

  async endOperationOverride(
    actor: PlatformPrincipal,
    tenantId: string,
    overrideId: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (!UUID.safeParse(overrideId).success) throw NOT_FOUND();
    await this.requireTenant(tenantId);
    await this.db.withTenant(tenantId, async (tx) => {
      const ended = await tx.tenantOperationOverride.updateMany({
        where: { id: overrideId, endedAt: null },
        data: { endedAt: this.clock.now(), endedByPlatformUserId: actor.platformUserId },
      });
      if (ended.count !== 1) throw NOT_FOUND();
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'operation_override.ended',
          targetType: 'tenant_operation_override',
          targetId: overrideId,
          tenantId,
          ...ipOf(meta),
        },
        tx,
      );
    });
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** Roles de sistema desde TODAS las plantillas de la base (security.md §2), como RolesService pero en esta tx. */
  /** Invitación hecha por el staff, dentro de la transacción (con el contexto del tenant ya fijado). */
  private async invite(
    tx: Prisma.TransactionClient,
    actor: PlatformPrincipal,
    tenantId: string,
    email: string,
    roleIds: string[],
    now: Date,
    meta: RequestMeta,
  ): Promise<InvitationLink> {
    const { token, hash } = newInvitationToken(tenantId);
    const row = await tx.membershipInvitation.create({
      data: {
        tenantId,
        email,
        roleIds,
        tokenHash: new Uint8Array(hash),
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        invitedByPlatformUserId: actor.platformUserId,
        createdAt: now,
      },
      select: { id: true, email: true, expiresAt: true },
    });
    // El correo no se guarda en la auditoría (dato personal): basta con el id de la invitación.
    await this.audit.record(
      {
        platformUserId: actor.platformUserId,
        action: 'invitation.created',
        targetType: 'membership_invitation',
        targetId: row.id,
        tenantId,
        ...ipOf(meta),
      },
      tx,
    );
    return {
      id: row.id,
      email: row.email,
      expiresAt: row.expiresAt.toISOString(),
      link: invitationLink(this.env.AUTH_HUB_HOST, token),
    };
  }

  /** Roles de sistema desde las plantillas; devuelve código de plantilla → id del rol. */
  private async instantiateRoles(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<Map<string, string>> {
    const created = new Map<string, string>();
    const templates = await tx.roleTemplate.findMany({
      select: { id: true, code: true, name: true, permissionCodes: true },
    });
    for (const template of templates) {
      const permissions = await tx.permission.findMany({
        where: { code: { in: template.permissionCodes } },
        select: { id: true },
      });
      const role = await tx.role.create({
        data: { tenantId, name: template.name, templateId: template.id, isSystem: true },
        select: { id: true },
      });
      await tx.rolePermission.createMany({
        data: permissions.map((p) => ({ tenantId, roleId: role.id, permissionId: p.id })),
      });
      created.set(template.code, role.id);
    }
    return created;
  }

  private async requireTenant(tenantId: string): Promise<void> {
    if (!UUID.safeParse(tenantId).success) throw NOT_FOUND();
    if (!(await this.db.client.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })))
      throw NOT_FOUND();
  }
}

const OVERRIDE_SELECT = {
  id: true,
  category: true,
  validFrom: true,
  validTo: true,
  reason: true,
  endedAt: true,
} as const;

function toOverride(o: {
  id: string;
  category: 'USERS_ADD';
  validFrom: Date;
  validTo: Date;
  reason: string;
  endedAt: Date | null;
}): OperationOverride {
  return {
    id: o.id,
    category: o.category,
    validFrom: o.validFrom.toISOString(),
    validTo: o.validTo.toISOString(),
    reason: o.reason,
    endedAt: o.endedAt?.toISOString() ?? null,
  };
}
