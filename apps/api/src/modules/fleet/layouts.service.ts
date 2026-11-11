import { Injectable } from '@nestjs/common';
import {
  LAYOUT_SCHEMA_VERSION,
  LayoutDocumentSchema,
  ZONE_RULES,
  deriveInventory,
  emptyLayout,
  validateLayout,
  type CreateLayoutAssignmentRequest,
  type CreateLayoutRequest,
  type Layout,
  type LayoutAssignment,
  type LayoutDocument,
  type LayoutIssue,
  type LayoutVersionDetail,
  type Modality,
  type UpdateLayoutRequest,
} from '@yebo/contracts';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { Prisma } from '../../generated/prisma/client';
import { FleetContext } from './fleet-context';
import { NOT_FOUND, isoDate } from './fleet.service';

const UUID = z.uuid();
type Tx = Parameters<Parameters<TenantDbService['transaction']>[0]>[0];

const SERVICE_NAME = {
  PASSENGER: 'pasajeros',
  PARCEL: 'encomiendas',
  CARGO: 'carga',
  VEHICLE_TRANSPORT: 'transporte de vehículos',
} as const;

/**
 * Layouts de los vehículos (Fase 6.3; data-dictionary §4; capacity-and-inventory §2–4; F6-Q1).
 * - Guardar el borrador solo exige la forma del documento (el DTO): se guarda a medias. Publicar exige todas las
 *   reglas (`validateLayout`) y que cada zona sea de un servicio que la empresa opera en la modalidad del layout.
 * - Publicar materializa el documento en zonas, elementos y reglas de capacidad, en la misma transacción en que la
 *   versión pasa a publicada; después nada de eso cambia (triggers y privilegios). Escrituras de un mismo layout
 *   serializadas con su fila (`FOR UPDATE`).
 * - Una versión publicada se asigna a vehículos de su modalidad (y de su tipo, si el layout lo fija) por fechas
 *   [desde, hasta) sin solaparse (la base lo garantiza). No se archiva una versión ni un layout en uso hoy o después.
 */
@Injectable()
export class LayoutsService {
  constructor(
    private readonly db: TenantDbService,
    private readonly ctx: FleetContext,
  ) {}

  async list(): Promise<Layout[]> {
    const today = this.ctx.today();
    const rows = await this.db.transaction((tx) =>
      tx.vehicleLayout.findMany({
        orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        include: {
          vehicleType: { select: { name: true } },
          versions: {
            orderBy: { version: 'desc' },
            include: {
              assignments: {
                where: { OR: [{ validTo: null }, { validTo: { gt: new Date(`${today}T00:00:00Z`) } }] },
                select: { vehicleId: true },
              },
            },
          },
        },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      modality: r.modality,
      vehicleTypeId: r.vehicleTypeId,
      vehicleTypeName: r.vehicleType?.name ?? null,
      archived: r.archivedAt !== null,
      versions: r.versions.map((v) => ({
        version: v.version,
        status: v.status,
        updatedAt: v.updatedAt.toISOString(),
        publishedAt: v.publishedAt?.toISOString() ?? null,
        summary: deriveInventory(parseDocument(v.document)).summary,
        assignedVehicles: new Set(v.assignments.map((a) => a.vehicleId)).size,
      })),
    }));
  }

  /** El layout y su primer borrador (vacío o con el documento dado, p. ej. una plantilla). */
  async create(input: CreateLayoutRequest): Promise<LayoutVersionDetail> {
    const tenantId = this.ctx.tenantId();
    const document = input.document ?? emptyLayout(input.modality);
    try {
      return await this.db.transaction(async (tx) => {
        await this.assertModality(tx, input.modality);
        await this.assertVehicleType(tx, input.vehicleTypeId, input.modality);
        const layout = await tx.vehicleLayout.create({
          data: { tenantId, name: input.name, modality: input.modality, vehicleTypeId: input.vehicleTypeId },
          select: { id: true },
        });
        await tx.layoutVersion.create({
          data: {
            tenantId,
            layoutId: layout.id,
            version: 1,
            status: 'DRAFT',
            draftSlot: true,
            ...docColumns(document),
          },
          select: { id: true },
        });
        return detail(layout.id, 1, 'DRAFT', document);
      });
    } catch (e) {
      if (isUnique(e)) throw duplicateName(input.name);
      throw e;
    }
  }

  async update(id: string, input: UpdateLayoutRequest): Promise<Layout> {
    try {
      await this.db.transaction(async (tx) => {
        const layout = await this.lockLayout(tx, id);
        await this.assertVehicleType(tx, input.vehicleTypeId, layout.modality);
        if (input.vehicleTypeId && input.vehicleTypeId !== layout.vehicleTypeId) {
          // Fijar un tipo no deja asignaciones vigentes a vehículos de otro tipo.
          const other = await tx.vehicleLayoutAssignment.count({
            where: {
              version: { layoutId: id },
              vehicle: { vehicleTypeId: { not: input.vehicleTypeId } },
              ...this.currentOrFuture(),
            },
          });
          if (other > 0) {
            throw new AppError('CONFLICT', 'El layout está asignado a vehículos de otro tipo', 409);
          }
        }
        await tx.vehicleLayout.update({
          where: { id },
          data: { name: input.name, vehicleTypeId: input.vehicleTypeId },
        });
      });
    } catch (e) {
      if (isUnique(e)) throw duplicateName(input.name);
      throw e;
    }
    const found = (await this.list()).find((l) => l.id === id);
    if (!found) throw NOT_FOUND();
    return found;
  }

  async archive(id: string, archived: boolean): Promise<Layout> {
    await this.db.transaction(async (tx) => {
      await this.lockLayout(tx, id);
      if (archived) {
        const inUse = await tx.vehicleLayoutAssignment.count({
          where: { version: { layoutId: id }, ...this.currentOrFuture() },
        });
        if (inUse > 0) {
          throw new AppError(
            'CONFLICT',
            'El layout está asignado a vehículos hoy o más adelante: termina esas asignaciones',
            409,
          );
        }
      }
      await tx.vehicleLayout.update({
        where: { id },
        data: { archivedAt: archived ? this.ctx.now() : null },
      });
    });
    const found = (await this.list()).find((l) => l.id === id);
    if (!found) throw NOT_FOUND();
    return found;
  }

  async version(id: string, version: number): Promise<LayoutVersionDetail> {
    if (!UUID.safeParse(id).success || !Number.isInteger(version) || version < 1) throw NOT_FOUND();
    const row = await this.db.transaction((tx) =>
      tx.layoutVersion.findFirst({
        where: { layoutId: id, version },
        select: { version: true, status: true, document: true },
      }),
    );
    if (!row) throw NOT_FOUND();
    return detail(id, row.version, row.status, parseDocument(row.document));
  }

  /** Crea o reemplaza el borrador. Solo la forma (ya validada por el DTO): se puede guardar a medias. */
  async saveDraft(id: string, document: LayoutDocument): Promise<LayoutVersionDetail> {
    const tenantId = this.ctx.tenantId();
    const version = await this.db.transaction(async (tx) => {
      const layout = await this.lockLayout(tx, id);
      if (layout.archivedAt)
        throw new AppError('CONFLICT', 'El layout está archivado: restáuralo para editarlo', 409);
      const draft = await tx.layoutVersion.findFirst({
        where: { layoutId: id, status: 'DRAFT' },
        select: { id: true, version: true },
      });
      if (draft) {
        await tx.layoutVersion.update({ where: { id: draft.id }, data: docColumns(document) });
        return draft.version;
      }
      const last = await tx.layoutVersion.aggregate({ where: { layoutId: id }, _max: { version: true } });
      const next = (last._max.version ?? 0) + 1;
      await tx.layoutVersion.create({
        data: {
          tenantId,
          layoutId: id,
          version: next,
          status: 'DRAFT',
          draftSlot: true,
          ...docColumns(document),
        },
        select: { id: true },
      });
      return next;
    });
    return detail(id, version, 'DRAFT', document);
  }

  /**
   * Publica el borrador: comprueba las reglas, materializa zonas, elementos (con sus camarotes padre) y reglas de
   * capacidad, y la versión pasa a publicada con su autor. Todo o nada.
   */
  async publish(id: string): Promise<LayoutVersionDetail> {
    const tenantId = this.ctx.tenantId();
    const actor = this.ctx.actor();
    const published = await this.db.transaction(async (tx) => {
      const layout = await this.lockLayout(tx, id);
      if (layout.archivedAt)
        throw new AppError('CONFLICT', 'El layout está archivado: restáuralo para publicarlo', 409);
      const draft = await tx.layoutVersion.findFirst({
        where: { layoutId: id, status: 'DRAFT' },
        select: { id: true, version: true, document: true },
      });
      if (!draft) throw new AppError('CONFLICT', 'No hay un borrador que publicar', 409);
      const document = parseDocument(draft.document);
      const issues = [
        ...validateLayout(document),
        ...(await this.serviceIssues(tx, document, layout.modality)),
      ];
      if (issues.length > 0) throw notPublishable(issues);

      const inventory = deriveInventory(document);
      const zoneIds = new Map<string, string>();
      for (const z of document.zones) {
        const row = await tx.layoutZone.create({
          data: {
            tenantId,
            layoutVersionId: draft.id,
            code: z.code,
            name: z.name,
            kind: z.kind,
            service: z.service,
            allocationMode: ZONE_RULES[z.kind].mode,
            deck: z.deck,
            geometry: z.rect,
            priceClassCode: z.priceClassCode,
            constraints: z.constraints ?? Prisma.DbNull,
          },
          select: { id: true },
        });
        zoneIds.set(z.code, row.id);
        if (z.capacity.length > 0) {
          await tx.capacityRule.createMany({
            data: z.capacity.map((c) => ({
              tenantId,
              zoneId: row.id,
              dimension: c.dimension,
              capacity: c.value,
            })),
          });
        }
      }
      const resources = new Map(inventory.resources.map((r) => [r.code, r]));
      const elementIds = new Map<string, string>();
      // Primero los padres (camarotes): sus camas los referencian.
      const ordered = [...document.elements].sort(
        (a, b) => Number(a.parentCode !== null) - Number(b.parentCode !== null),
      );
      for (const e of ordered) {
        const r = resources.get(e.code);
        const row = await tx.layoutElement.create({
          data: {
            tenantId,
            layoutVersionId: draft.id,
            zoneId: e.zoneCode ? (zoneIds.get(e.zoneCode) ?? null) : null,
            parentElementId: e.parentCode ? (elementIds.get(e.parentCode) ?? null) : null,
            kind: e.kind,
            code: e.code,
            isAssignable: r?.isSellable ?? false,
            sellableAsUnit: r?.sellableAsUnit ?? false,
            x: e.x,
            y: e.y,
            w: e.w,
            h: e.h,
            rotation: e.rotation,
            deck: e.deck,
            capacity: e.capacity,
            priceClassCode: r?.priceClassCode ?? e.priceClassCode,
            attributes: e.label ? { label: e.label } : {},
          },
          select: { id: true },
        });
        elementIds.set(e.code, row.id);
      }
      await tx.layoutVersion.update({
        where: { id: draft.id },
        data: {
          status: 'PUBLISHED',
          draftSlot: null,
          publishedAt: this.ctx.now(),
          publishedByKind: actor.kind,
          publishedById: actor.id,
        },
      });
      return { version: draft.version, document };
    });
    return detail(id, published.version, 'PUBLISHED', published.document);
  }

  /** Archiva una versión publicada que nadie usa hoy ni después (los viajes pasados la conservan). */
  async archiveVersion(id: string, version: number): Promise<LayoutVersionDetail> {
    const row = await this.db.transaction(async (tx) => {
      await this.lockLayout(tx, id);
      const v = await tx.layoutVersion.findFirst({
        where: { layoutId: id, version },
        select: { id: true, status: true, document: true },
      });
      if (!v) throw NOT_FOUND();
      if (v.status !== 'PUBLISHED')
        throw new AppError('CONFLICT', 'Solo se archiva una versión publicada', 409);
      const inUse = await tx.vehicleLayoutAssignment.count({
        where: { layoutVersionId: v.id, ...this.currentOrFuture() },
      });
      if (inUse > 0) {
        throw new AppError('CONFLICT', 'La versión está asignada a vehículos hoy o más adelante', 409);
      }
      await tx.layoutVersion.update({ where: { id: v.id }, data: { status: 'ARCHIVED' } });
      return v;
    });
    return detail(id, version, 'ARCHIVED', parseDocument(row.document));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Asignaciones a vehículos
  // ---------------------------------------------------------------------------------------------------------------

  async assignments(vehicleId: string): Promise<LayoutAssignment[]> {
    if (!UUID.safeParse(vehicleId).success) throw NOT_FOUND();
    const rows = await this.db.transaction(async (tx) => {
      const vehicle = await tx.vehicle.findFirst({ where: { id: vehicleId }, select: { id: true } });
      if (!vehicle) throw NOT_FOUND();
      return tx.vehicleLayoutAssignment.findMany({
        where: { vehicleId },
        orderBy: { validFrom: 'desc' },
        include: ASSIGNMENT_INCLUDE,
      });
    });
    return rows.map(toAssignment);
  }

  async assign(vehicleId: string, input: CreateLayoutAssignmentRequest): Promise<LayoutAssignment> {
    if (!UUID.safeParse(vehicleId).success) throw NOT_FOUND();
    const tenantId = this.ctx.tenantId();
    try {
      const row = await this.db.transaction(async (tx) => {
        const vehicle = await tx.vehicle.findFirst({
          where: { id: vehicleId },
          select: { modality: true, vehicleTypeId: true, status: true },
        });
        if (!vehicle) throw NOT_FOUND();
        if (vehicle.status === 'RETIRED') throw new AppError('CONFLICT', 'El vehículo está retirado', 409);
        const version = await tx.layoutVersion.findFirst({
          where: { layoutId: input.layoutId, version: input.version },
          select: {
            id: true,
            status: true,
            layout: { select: { modality: true, vehicleTypeId: true, archivedAt: true } },
          },
        });
        if (!version) throw new AppError('VALIDATION_FAILED', 'Esa versión del layout no existe', 400);
        if (version.status !== 'PUBLISHED') {
          throw new AppError('VALIDATION_FAILED', 'Solo se asigna una versión publicada', 400);
        }
        if (version.layout.archivedAt)
          throw new AppError('VALIDATION_FAILED', 'El layout está archivado', 400);
        if (version.layout.modality !== vehicle.modality) {
          throw new AppError('VALIDATION_FAILED', 'El layout es de otra modalidad que el vehículo', 400);
        }
        if (version.layout.vehicleTypeId && version.layout.vehicleTypeId !== vehicle.vehicleTypeId) {
          throw new AppError('VALIDATION_FAILED', 'El layout es para otro tipo de vehículo', 400);
        }
        return tx.vehicleLayoutAssignment.create({
          data: {
            tenantId,
            vehicleId,
            layoutVersionId: version.id,
            validFrom: day(input.validFrom),
            validTo: input.validTo ? day(input.validTo) : null,
          },
          include: ASSIGNMENT_INCLUDE,
        });
      });
      return toAssignment(row);
    } catch (e) {
      throw overlap(e) ?? e;
    }
  }

  /** Termina una asignación (o adelanta su fin). El fin es posterior al inicio y no se solapa con otra. */
  async endAssignment(vehicleId: string, assignmentId: string, validTo: string): Promise<LayoutAssignment> {
    if (!UUID.safeParse(vehicleId).success || !UUID.safeParse(assignmentId).success) throw NOT_FOUND();
    try {
      const row = await this.db.transaction(async (tx) => {
        const current = await tx.vehicleLayoutAssignment.findFirst({
          where: { id: assignmentId, vehicleId },
          select: { validFrom: true },
        });
        if (!current) throw NOT_FOUND();
        if (validTo <= (isoDate(current.validFrom) ?? '')) {
          throw new AppError('VALIDATION_FAILED', 'El fin debe ser posterior al inicio', 400);
        }
        return tx.vehicleLayoutAssignment.update({
          where: { id: assignmentId },
          data: { validTo: day(validTo) },
          include: ASSIGNMENT_INCLUDE,
        });
      });
      return toAssignment(row);
    } catch (e) {
      throw overlap(e) ?? e;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** Asignaciones vigentes hoy o que empiezan más adelante (hasta posterior a hoy, o sin fin). */
  private currentOrFuture() {
    const today = new Date(`${this.ctx.today()}T00:00:00Z`);
    return { OR: [{ validTo: null }, { validTo: { gt: today } }] };
  }

  private async lockLayout(tx: Tx, id: string) {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const [row] = await tx.$queryRaw<
      { modality: Modality; vehicleTypeId: string | null; archivedAt: Date | null }[]
    >`SELECT modality::text AS modality, vehicle_type_id::text AS "vehicleTypeId", archived_at AS "archivedAt"
        FROM vehicle_layouts WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw NOT_FOUND();
    return row;
  }

  private async assertModality(tx: Tx, modality: Modality): Promise<void> {
    const operated = await tx.tenantService.count({ where: { modality, enabled: true } });
    if (operated === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `La empresa no opera servicios de transporte ${modality === 'LAND' ? 'terrestre' : 'fluvial'}`,
        400,
      );
    }
  }

  private async assertVehicleType(tx: Tx, typeId: string | null, modality: Modality): Promise<void> {
    if (typeId === null) return;
    const type = await tx.vehicleType.findFirst({
      where: { id: typeId },
      select: { modality: true, archivedAt: true },
    });
    if (!type) throw new AppError('VALIDATION_FAILED', 'El tipo de vehículo no existe', 400);
    if (type.archivedAt) throw new AppError('VALIDATION_FAILED', 'El tipo de vehículo está archivado', 400);
    if (type.modality !== modality) {
      throw new AppError('VALIDATION_FAILED', 'El tipo de vehículo es de otra modalidad', 400);
    }
  }

  /** Cada zona es de un servicio que la empresa opera en la modalidad del layout. */
  private async serviceIssues(tx: Tx, doc: LayoutDocument, modality: Modality): Promise<LayoutIssue[]> {
    const operated = new Set(
      (
        await tx.tenantService.findMany({ where: { modality, enabled: true }, select: { service: true } })
      ).map((s) => s.service),
    );
    return doc.zones.flatMap((z, i) =>
      operated.has(z.service)
        ? []
        : [
            {
              path: `zones.${i}.service`,
              message: `La empresa no opera ${SERVICE_NAME[z.service]} en esta modalidad (zona ${z.code})`,
            },
          ],
    );
  }
}

const ASSIGNMENT_INCLUDE = {
  version: { select: { version: true, layoutId: true, layout: { select: { name: true } } } },
} as const;

type AssignmentRow = Prisma.VehicleLayoutAssignmentGetPayload<{ include: typeof ASSIGNMENT_INCLUDE }>;

function toAssignment(r: AssignmentRow): LayoutAssignment {
  return {
    id: r.id,
    vehicleId: r.vehicleId,
    layoutId: r.version.layoutId,
    layoutName: r.version.layout.name,
    version: r.version.version,
    validFrom: isoDate(r.validFrom) ?? '',
    validTo: isoDate(r.validTo),
  };
}

const day = (d: string) => new Date(`${d}T00:00:00Z`);

/** Columnas de la versión que salen del documento. */
function docColumns(document: LayoutDocument) {
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    document: document as unknown as Prisma.InputJsonValue,
    decks: document.decks.length,
    canvas: document.decks as unknown as Prisma.InputJsonValue,
    totalPersons: document.totalPersons,
  };
}

/** Lo guardado ya pasó el esquema al guardarse; si el esquema cambia, se nota aquí (500 con el motivo en el log). */
function parseDocument(value: unknown): LayoutDocument {
  return LayoutDocumentSchema.parse(value);
}

function detail(
  layoutId: string,
  version: number,
  status: LayoutVersionDetail['status'],
  document: LayoutDocument,
): LayoutVersionDetail {
  const issues = status === 'DRAFT' ? validateLayout(document) : [];
  return { layoutId, version, status, document, issues, inventory: deriveInventory(document) };
}

function notPublishable(issues: LayoutIssue[]): AppError {
  const first = issues
    .slice(0, 3)
    .map((i) => i.message)
    .join('; ');
  const more = issues.length > 3 ? ` (y ${issues.length - 3} más)` : '';
  return new AppError(
    'VALIDATION_FAILED',
    `No se puede publicar: ${issues.length === 1 ? 'hay un dato' : `hay ${issues.length} datos`} por corregir. ${first}${more}`,
    400,
  );
}

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

function duplicateName(name: string) {
  return new AppError('CONFLICT', `Ya existe un layout llamado «${name}»`, 409);
}

/** La restricción de exclusión (23P01) rechazó una asignación que se solapa con otra del mismo vehículo. */
function overlap(e: unknown): AppError | null {
  const text =
    e instanceof Error ? `${e.message} ${JSON.stringify((e as { meta?: unknown }).meta ?? {})}` : '';
  if (!/23P01|vehicle_layout_assignments_no_overlap|exclusion/i.test(text)) return null;
  return new AppError('CONFLICT', 'El vehículo ya tiene un layout asignado en esas fechas', 409);
}
