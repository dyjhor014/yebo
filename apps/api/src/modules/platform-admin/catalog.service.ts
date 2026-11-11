import { Injectable } from '@nestjs/common';
import {
  PlanLimitsSchema,
  SuspensionPolicySchema,
  type ModuleOverride,
  type ModuleOverrideInput,
  type Plan,
  type PlanVersion,
  type PlanVersionInput,
} from '@yebo/contracts';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { Prisma } from '../../generated/prisma/client';
import { Clock } from '../identity/clock';
import { BackofficePrismaService } from './backoffice-prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import { ipOf, type PlatformPrincipal, type RequestMeta } from './platform-auth.service';

const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
const ONLY_DRAFT = () =>
  new AppError(
    'CONFLICT',
    'Solo se puede modificar una versión en borrador: las publicadas son inmutables',
    409,
  );

const versionSelect = {
  id: true,
  version: true,
  status: true,
  currency: true,
  basePrice: true,
  billingInterval: true,
  includedUsers: true,
  extraUserPrice: true,
  usageMetric: true,
  dailyAggregation: true,
  minActiveSeconds: true,
  trialDays: true,
  paymentTermsDays: true,
  taxRate: true,
  limits: true,
  suspensionPolicy: true,
  publishedAt: true,
  retiredAt: true,
  modules: { select: { module: { select: { code: true } } } },
} as const;

type VersionRow = Prisma.PlanVersionGetPayload<{ select: typeof versionSelect }>;

/**
 * Catálogo comercial del superadmin (Fase 4.2): módulos (solo lectura: se siembran por migración), planes y versiones
 * (borrador → publicada → retirada; una publicada es inmutable, ADR-010, con trigger en la base como respaldo) y
 * excepciones de módulo por tenant (temporales, con motivo y auditadas). Ningún precio lo fija el sistema.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly db: BackofficePrismaService,
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
  ) {}

  async listModules() {
    return this.db.client.module.findMany({
      where: { isActive: true },
      select: { code: true, name: true, description: true },
      orderBy: { code: 'asc' },
    });
  }

  async listPlans(): Promise<Plan[]> {
    const plans = await this.db.client.plan.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        status: true,
        versions: { select: versionSelect, orderBy: { version: 'asc' } },
      },
      orderBy: { code: 'asc' },
    });
    return plans.map((p) => ({ ...p, versions: p.versions.map(toVersion) }));
  }

  async createPlan(
    actor: PlatformPrincipal,
    input: { code: string; name: string; description: string },
    meta: RequestMeta,
  ): Promise<Plan> {
    return this.db.client.$transaction(async (tx) => {
      if (await tx.plan.findUnique({ where: { code: input.code }, select: { id: true } })) {
        throw new AppError('CONFLICT', 'Ya existe un plan con ese código', 409);
      }
      const plan = await tx.plan.create({
        data: input,
        select: { id: true, code: true, name: true, description: true, status: true },
      });
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'plan.created',
          targetType: 'plan',
          targetId: plan.id,
          ...ipOf(meta),
        },
        tx,
      );
      return { ...plan, versions: [] };
    });
  }

  /** Nueva versión en borrador (número = último + 1). */
  async createVersion(
    actor: PlatformPrincipal,
    planId: string,
    input: PlanVersionInput,
    meta: RequestMeta,
  ): Promise<PlanVersion> {
    if (!UUID.safeParse(planId).success) throw NOT_FOUND();
    return this.db.client.$transaction(async (tx) => {
      // Serializa las altas de versiones del mismo plan (número consecutivo sin colisiones).
      const [plan] = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM plans WHERE id = ${planId}::uuid FOR UPDATE`;
      if (!plan) throw NOT_FOUND();
      const last = await tx.planVersion.findFirst({
        where: { planId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const moduleIds = await this.moduleIds(tx, input.modules);
      const version = await tx.planVersion.create({
        data: {
          planId,
          version: (last?.version ?? 0) + 1,
          createdById: actor.platformUserId,
          ...columns(input),
        },
        select: { id: true },
      });
      await tx.planVersionModule.createMany({
        data: moduleIds.map((moduleId) => ({ planVersionId: version.id, moduleId })),
      });
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'plan_version.created',
          targetType: 'plan_version',
          targetId: version.id,
          ...ipOf(meta),
        },
        tx,
      );
      return toVersion(
        await tx.planVersion.findUniqueOrThrow({ where: { id: version.id }, select: versionSelect }),
      );
    });
  }

  /** Reemplaza el contenido de un borrador (campos y módulos). */
  async updateDraft(
    actor: PlatformPrincipal,
    versionId: string,
    input: PlanVersionInput,
    meta: RequestMeta,
  ): Promise<PlanVersion> {
    return this.inDraft(versionId, async (tx) => {
      const moduleIds = await this.moduleIds(tx, input.modules);
      await tx.planVersion.update({ where: { id: versionId }, data: columns(input) });
      await tx.planVersionModule.deleteMany({ where: { planVersionId: versionId } });
      await tx.planVersionModule.createMany({
        data: moduleIds.map((moduleId) => ({ planVersionId: versionId, moduleId })),
      });
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'plan_version.updated',
          targetType: 'plan_version',
          targetId: versionId,
          ...ipOf(meta),
        },
        tx,
      );
    });
  }

  /** Publica un borrador: desde ese momento es inmutable y el plan queda ACTIVE. */
  async publish(actor: PlatformPrincipal, versionId: string, meta: RequestMeta): Promise<PlanVersion> {
    return this.inDraft(versionId, async (tx, planId) => {
      const modules = await tx.planVersionModule.count({ where: { planVersionId: versionId } });
      if (modules === 0) throw new AppError('CONFLICT', 'Una versión sin módulos no se puede publicar', 409);
      await tx.planVersion.update({
        where: { id: versionId },
        data: { status: 'PUBLISHED', publishedAt: this.clock.now() },
      });
      await tx.plan.updateMany({ where: { id: planId, status: 'DRAFT' }, data: { status: 'ACTIVE' } });
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'plan_version.published',
          targetType: 'plan_version',
          targetId: versionId,
          ...ipOf(meta),
        },
        tx,
      );
    });
  }

  /** Retira una versión publicada: deja de ofrecerse; las suscripciones existentes la conservan. */
  async retire(actor: PlatformPrincipal, versionId: string, meta: RequestMeta): Promise<PlanVersion> {
    if (!UUID.safeParse(versionId).success) throw NOT_FOUND();
    return this.db.client.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM plan_versions WHERE id = ${versionId}::uuid FOR UPDATE`;
      if (!row) throw NOT_FOUND();
      if (row.status !== 'PUBLISHED')
        throw new AppError('CONFLICT', 'Solo se retira una versión publicada', 409);
      await tx.planVersion.update({
        where: { id: versionId },
        data: { status: 'RETIRED', retiredAt: this.clock.now() },
      });
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'plan_version.retired',
          targetType: 'plan_version',
          targetId: versionId,
          ...ipOf(meta),
        },
        tx,
      );
      return toVersion(
        await tx.planVersion.findUniqueOrThrow({ where: { id: versionId }, select: versionSelect }),
      );
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Excepciones de módulo por tenant (con el contexto del tenant fijado: RLS activo)
  // ---------------------------------------------------------------------------------------------------------------

  async listOverrides(tenantId: string): Promise<ModuleOverride[]> {
    await this.requireTenant(tenantId);
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.tenantModuleOverride.findMany({
        select: {
          id: true,
          effect: true,
          validFrom: true,
          validTo: true,
          reason: true,
          endedAt: true,
          module: { select: { code: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map(toOverride);
  }

  async createOverride(
    actor: PlatformPrincipal,
    tenantId: string,
    input: ModuleOverrideInput,
    meta: RequestMeta,
  ): Promise<ModuleOverride> {
    await this.requireTenant(tenantId);
    const validFrom = input.validFrom ? new Date(input.validFrom) : this.clock.now();
    const validTo = input.validTo ? new Date(input.validTo) : null;
    if (validTo && validTo <= validFrom) {
      throw new AppError('VALIDATION_FAILED', 'El fin de la excepción debe ser posterior a su inicio', 400);
    }
    return this.db.withTenant(tenantId, async (tx) => {
      const [moduleId] = await this.moduleIds(tx, [input.moduleCode]);
      const row = await tx.tenantModuleOverride.create({
        data: {
          tenantId,
          moduleId: moduleId as string,
          effect: input.effect,
          validFrom,
          validTo,
          reason: input.reason,
          grantedByPlatformUserId: actor.platformUserId,
        },
        select: {
          id: true,
          effect: true,
          validFrom: true,
          validTo: true,
          reason: true,
          endedAt: true,
          module: { select: { code: true } },
        },
      });
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'module_override.created',
          targetType: 'tenant_module_override',
          targetId: row.id,
          tenantId,
          detail: { module: input.moduleCode, effect: input.effect, reason: input.reason },
          ...ipOf(meta),
        },
        tx,
      );
      return toOverride(row);
    });
  }

  /** Termina una excepción antes de su fin previsto (no se borra: queda en el historial). */
  async endOverride(
    actor: PlatformPrincipal,
    tenantId: string,
    overrideId: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (!UUID.safeParse(overrideId).success) throw NOT_FOUND();
    await this.requireTenant(tenantId);
    await this.db.withTenant(tenantId, async (tx) => {
      const ended = await tx.tenantModuleOverride.updateMany({
        where: { id: overrideId, endedAt: null },
        data: { endedAt: this.clock.now(), endedByPlatformUserId: actor.platformUserId },
      });
      if (ended.count !== 1) throw NOT_FOUND();
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'module_override.ended',
          targetType: 'tenant_module_override',
          targetId: overrideId,
          tenantId,
          ...ipOf(meta),
        },
        tx,
      );
    });
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async inDraft(
    versionId: string,
    fn: (tx: Prisma.TransactionClient, planId: string) => Promise<void>,
  ): Promise<PlanVersion> {
    if (!UUID.safeParse(versionId).success) throw NOT_FOUND();
    return this.db.client.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ status: string; plan_id: string }[]>`
        SELECT status::text AS status, plan_id FROM plan_versions WHERE id = ${versionId}::uuid FOR UPDATE`;
      if (!row) throw NOT_FOUND();
      if (row.status !== 'DRAFT') throw ONLY_DRAFT();
      await fn(tx, row.plan_id);
      return toVersion(
        await tx.planVersion.findUniqueOrThrow({ where: { id: versionId }, select: versionSelect }),
      );
    });
  }

  private async moduleIds(tx: Prisma.TransactionClient, codes: readonly string[]): Promise<string[]> {
    const rows = await tx.module.findMany({
      where: { code: { in: [...codes] }, isActive: true },
      select: { id: true, code: true },
    });
    const unknown = codes.filter((c) => !rows.some((r) => r.code === c));
    if (unknown.length > 0) {
      throw new AppError('VALIDATION_FAILED', `Módulos inexistentes: ${unknown.join(', ')}`, 400);
    }
    return codes.map((c) => rows.find((r) => r.code === c)?.id as string);
  }

  private async requireTenant(tenantId: string): Promise<void> {
    if (!UUID.safeParse(tenantId).success) throw NOT_FOUND();
    if (!(await this.db.client.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })))
      throw NOT_FOUND();
  }
}

function columns(input: PlanVersionInput) {
  return {
    currency: input.currency,
    basePrice: new Prisma.Decimal(input.basePrice),
    billingInterval: input.billingInterval,
    includedUsers: input.includedUsers,
    extraUserPrice: new Prisma.Decimal(input.extraUserPrice),
    usageMetric: input.usageMetric,
    dailyAggregation: input.dailyAggregation,
    minActiveSeconds: input.minActiveSeconds,
    trialDays: input.trialDays,
    paymentTermsDays: input.paymentTermsDays,
    taxRate: new Prisma.Decimal(input.taxRate),
    limits: PlanLimitsSchema.parse(input.limits),
    suspensionPolicy: SuspensionPolicySchema.parse(input.suspensionPolicy),
  };
}

function toVersion(v: VersionRow): PlanVersion {
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    currency: v.currency,
    basePrice: v.basePrice.toFixed(2),
    billingInterval: v.billingInterval,
    includedUsers: v.includedUsers,
    extraUserPrice: v.extraUserPrice.toFixed(2),
    usageMetric: v.usageMetric,
    dailyAggregation: v.dailyAggregation,
    minActiveSeconds: v.minActiveSeconds,
    trialDays: v.trialDays,
    paymentTermsDays: v.paymentTermsDays,
    taxRate: v.taxRate.toString(),
    limits: PlanLimitsSchema.parse(v.limits),
    suspensionPolicy: SuspensionPolicySchema.parse(v.suspensionPolicy),
    modules: v.modules.map((m) => m.module.code).sort(),
    publishedAt: v.publishedAt?.toISOString() ?? null,
    retiredAt: v.retiredAt?.toISOString() ?? null,
  };
}

function toOverride(o: {
  id: string;
  effect: 'GRANT' | 'REVOKE';
  validFrom: Date;
  validTo: Date | null;
  reason: string;
  endedAt: Date | null;
  module: { code: string };
}): ModuleOverride {
  return {
    id: o.id,
    moduleCode: o.module.code,
    effect: o.effect,
    validFrom: o.validFrom.toISOString(),
    validTo: o.validTo?.toISOString() ?? null,
    reason: o.reason,
    endedAt: o.endedAt?.toISOString() ?? null,
  };
}
