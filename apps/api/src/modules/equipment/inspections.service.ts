import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  EQUIPMENT_LIMITS,
  INSPECTION_DISCLAIMER,
  type CreateInspectionRequest,
  type InspectionDetail,
  type InspectionSummary,
  type TripInspectionsResponse,
  type UpdateInspectionItemRequest,
} from '@yebo/contracts';
import sharp from 'sharp';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { ObjectStorage } from '../../infrastructure/storage/object-storage';
import { FleetContext } from '../fleet/fleet-context';
import { UserDirectoryService } from '../identity/user-directory.service';

type Tx = Parameters<Parameters<TenantDbService['transaction']>[0]>[0];
const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, 400);
const conflict = (message: string) => new AppError('CONFLICT', message, 409);
const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const COMPLETED_MSG = 'La inspección ya está completada: para corregirla, crea una rectificación';
/** Lado mayor de una foto guardada y píxeles máximos de entrada. */
const PHOTO_MAX_SIDE = 2000;
const PHOTO_MAX_PIXELS = 50_000_000;

const SUMMARY_INCLUDE = {
  trip: { select: { id: true, code: true } },
  rectifiedBy: { where: { status: { not: 'DRAFT' } }, select: { id: true }, orderBy: { completedAt: 'asc' } },
  _count: { select: { items: true } },
} as const satisfies Prisma.VehicleInspectionInclude;
type SummaryRow = Prisma.VehicleInspectionGetPayload<{ include: typeof SUMMARY_INCLUDE }>;

/**
 * Inspecciones preoperacionales (Fase 7.E1; EQ-Q4, EQ-Q5, EQ-Q8, EQ-Q10). Opcionales: ningún flujo de viajes, venta,
 * asignación ni salida las exige ni las consulta.
 * - Una inspección nace en borrador con una copia de la unidad y de su equipamiento activo en ese momento (o, si es una
 *   rectificación, de los elementos de la original). Esa copia no cambia aunque cambie el equipamiento.
 * - Completada (todos los elementos marcados) queda inmutable; la base lo garantiza. Se corrige con una rectificación.
 * - El viaje es opcional y debe ser de la misma unidad. Las fotos son privadas: se recodifican a JPEG sin metadatos.
 */
@Injectable()
export class InspectionsService {
  constructor(
    private readonly db: TenantDbService,
    private readonly ctx: FleetContext,
    private readonly storage: ObjectStorage,
    private readonly directory: UserDirectoryService,
  ) {}

  async forVehicle(vehicleId: string): Promise<InspectionSummary[]> {
    if (!UUID.safeParse(vehicleId).success) throw NOT_FOUND();
    const rows = await this.db.transaction(async (tx) => {
      const v = await tx.vehicle.findFirst({ where: { id: vehicleId }, select: { id: true } });
      if (!v) throw NOT_FOUND();
      return tx.vehicleInspection.findMany({
        where: { vehicleId },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        include: SUMMARY_INCLUDE,
      });
    });
    return this.summaries(rows);
  }

  /** «Control preoperacional» de un viaje: sus inspecciones y la última completada de su unidad. */
  async forTrip(tripId: string): Promise<TripInspectionsResponse> {
    if (!UUID.safeParse(tripId).success) throw NOT_FOUND();
    const { trip, rows, latest } = await this.db.transaction(async (tx) => {
      const trip = await tx.trip.findFirst({ where: { id: tripId }, select: { id: true, vehicleId: true } });
      if (!trip) throw NOT_FOUND();
      const rows = await tx.vehicleInspection.findMany({
        where: { tripId },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        include: SUMMARY_INCLUDE,
      });
      const latest = trip.vehicleId
        ? await tx.vehicleInspection.findFirst({
            where: { vehicleId: trip.vehicleId, status: { not: 'DRAFT' } },
            orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
            include: SUMMARY_INCLUDE,
          })
        : null;
      return { trip, rows, latest };
    });
    const all = await this.summaries(latest ? [...rows, latest] : rows);
    return {
      tripId: trip.id,
      vehicleId: trip.vehicleId,
      inspections: all.slice(0, rows.length),
      latestForVehicle: latest ? (all[rows.length] ?? null) : null,
      disclaimer: INSPECTION_DISCLAIMER,
    };
  }

  async get(id: string): Promise<InspectionDetail> {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    return this.db.transaction((tx) => this.detail(tx, id));
  }

  /** Borrador nuevo de una unidad (con viaje opcional) o rectificación de una inspección completada. */
  async create(input: CreateInspectionRequest): Promise<InspectionDetail> {
    const actor = this.ctx.actor();
    const tenantId = this.ctx.tenantId();
    return this.db.transaction(async (tx) => {
      const vehicle = await tx.vehicle.findFirst({
        where: { id: input.vehicleId },
        select: { id: true, code: true, name: true, registrationId: true, status: true },
      });
      if (!vehicle) throw invalid('La unidad no es de la empresa');
      if (vehicle.status === 'RETIRED') throw conflict(`La unidad ${vehicle.code} está retirada`);

      let tripId = input.tripId;
      let snapshot: Prisma.VehicleInspectionItemCreateManyInput[] = [];
      const id = randomUUID();
      if (input.rectifiesId) {
        const original = await tx.vehicleInspection.findFirst({
          where: { id: input.rectifiesId },
          select: { vehicleId: true, status: true, tripId: true, items: { orderBy: { seq: 'asc' } } },
        });
        if (!original || original.vehicleId !== vehicle.id || original.status === 'DRAFT') {
          throw invalid('Solo se rectifica una inspección completada de la misma unidad');
        }
        tripId = tripId ?? original.tripId;
        // La rectificación corrige lo verificado en aquel momento: copia los elementos de la original.
        snapshot = original.items.map((it) => ({
          tenantId,
          inspectionId: id,
          vehicleEquipmentId: it.vehicleEquipmentId,
          seq: it.seq,
          name: it.name,
          category: it.category,
          declaredQuantity: it.declaredQuantity,
          declaredStatus: it.declaredStatus,
          serialNumber: it.serialNumber,
          expiresOn: it.expiresOn,
        }));
      } else {
        const equipment = await tx.vehicleEquipment.findMany({
          where: { vehicleId: vehicle.id, archivedAt: null },
          orderBy: [{ category: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        });
        if (equipment.length === 0) {
          throw invalid('La unidad no tiene equipamiento declarado: decláralo antes de inspeccionarla');
        }
        snapshot = equipment.map((e, seq) => ({
          tenantId,
          inspectionId: id,
          vehicleEquipmentId: e.id,
          seq,
          name: e.name,
          category: e.category,
          declaredQuantity: e.quantity,
          declaredStatus: e.status,
          serialNumber: e.serialNumber,
          expiresOn: e.expiresOn,
        }));
      }
      if (tripId) {
        const trip = await tx.trip.findFirst({
          where: { id: tripId },
          select: { vehicleId: true, status: true },
        });
        if (!trip) throw invalid('El viaje no es de la empresa');
        if (trip.vehicleId !== vehicle.id) throw invalid('El viaje no es de esa unidad');
        if (trip.status === 'CANCELLED') throw invalid('El viaje está cancelado');
      }
      await tx.vehicleInspection.create({
        data: {
          id,
          tenantId,
          vehicleId: vehicle.id,
          tripId,
          rectifiesId: input.rectifiesId,
          rectificationReason: input.rectificationReason,
          vehicleCode: vehicle.code,
          vehicleName: vehicle.name,
          vehicleRegistration: vehicle.registrationId,
          startedAt: this.ctx.now(),
          startedByKind: actor.kind,
          startedById: actor.id,
        },
      });
      await tx.vehicleInspectionItem.createMany({ data: snapshot });
      return this.detail(tx, id);
    });
  }

  async updateNotes(id: string, generalNotes: string | null): Promise<InspectionDetail> {
    return this.db.transaction(async (tx) => {
      await this.lockDraft(tx, id);
      await tx.vehicleInspection.update({ where: { id }, data: { generalNotes } });
      return this.detail(tx, id);
    });
  }

  async updateItem(
    id: string,
    itemId: string,
    input: UpdateInspectionItemRequest,
  ): Promise<InspectionDetail> {
    if (!UUID.safeParse(itemId).success) throw NOT_FOUND();
    return this.db.transaction(async (tx) => {
      await this.lockDraft(tx, id);
      const item = await tx.vehicleInspectionItem.findFirst({
        where: { id: itemId, inspectionId: id },
        select: { id: true },
      });
      if (!item) throw NOT_FOUND();
      await tx.vehicleInspectionItem.update({
        where: { id: itemId },
        data: { result: input.result, foundQuantity: input.foundQuantity, observation: input.observation },
      });
      return this.detail(tx, id);
    });
  }

  /** Completa: todos los elementos marcados; el resultado general y los conteos quedan fijos. */
  async complete(id: string): Promise<InspectionDetail> {
    const actor = this.ctx.actor();
    return this.db.transaction(async (tx) => {
      await this.lockDraft(tx, id);
      const items = await tx.vehicleInspectionItem.findMany({
        where: { inspectionId: id },
        select: { result: true },
      });
      const pending = items.filter((i) => i.result === null).length;
      if (pending > 0) {
        throw invalid(
          `Falta marcar ${pending} ${pending === 1 ? 'elemento' : 'elementos'} para completar la inspección`,
        );
      }
      const n = (r: string) => items.filter((i) => i.result === r).length;
      const counts = {
        conformingCount: n('CONFORMING'),
        observedCount: n('OBSERVED'),
        notOperationalCount: n('NOT_OPERATIONAL'),
        notAvailableCount: n('NOT_AVAILABLE'),
      };
      await tx.vehicleInspection.update({
        where: { id },
        data: {
          status: counts.conformingCount === items.length ? 'COMPLETED' : 'COMPLETED_WITH_OBSERVATIONS',
          completedAt: this.ctx.now(),
          completedByKind: actor.kind,
          completedById: actor.id,
          ...counts,
        },
      });
      return this.detail(tx, id);
    });
  }

  /** Descarta un borrador (con sus elementos y fotos). Una completada no se borra. */
  async discard(id: string): Promise<void> {
    const keys = await this.db.transaction(async (tx) => {
      await this.lockDraft(tx, id);
      const photos = await tx.vehicleInspectionEvidence.findMany({
        where: { inspectionId: id },
        select: { file: { select: { id: true, storageKey: true } } },
      });
      await tx.vehicleInspectionEvidence.deleteMany({ where: { inspectionId: id } });
      if (photos.length > 0) {
        await tx.fileAsset.updateMany({
          where: { id: { in: photos.map((p) => p.file.id) } },
          data: { status: 'DELETED' },
        });
      }
      await tx.vehicleInspectionItem.deleteMany({ where: { inspectionId: id } });
      await tx.vehicleInspection.delete({ where: { id } });
      return photos.map((p) => p.file.storageKey);
    });
    await Promise.all(keys.map((k) => this.storage.delete(k).catch(() => undefined)));
  }

  /** Foto de evidencia (en el cuerpo) de un elemento o de la inspección en general; solo en borrador. */
  async addPhoto(id: string, itemId: string | null, body: unknown): Promise<InspectionDetail> {
    if (!this.storage.enabled) {
      throw new AppError('SERVICE_UNAVAILABLE', 'El almacenamiento de archivos no está configurado', 503);
    }
    if (itemId !== null && !UUID.safeParse(itemId).success)
      throw invalid('El elemento no es de esta inspección');
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw invalid('Envía la foto como JPEG, PNG o WebP en el cuerpo');
    }
    if (body.length > EQUIPMENT_LIMITS.photoMaxBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', 'La foto pesa más de 5 MB', 413);
    }
    // Revisa antes de procesar: borrador, elemento de la inspección y cupo de fotos.
    await this.db.transaction(async (tx) => this.checkPhotoSlot(tx, id, itemId));
    const photo = await jpeg(body);
    const fileId = randomUUID();
    const storageKey = `tenants/${this.ctx.tenantId()}/inspections/${id}/${fileId}.jpg`;
    const actor = this.ctx.actor();
    await this.storage.put(storageKey, photo.data, 'image/jpeg');
    try {
      return await this.db.transaction(async (tx) => {
        await this.checkPhotoSlot(tx, id, itemId);
        await tx.fileAsset.create({
          data: {
            id: fileId,
            tenantId: this.ctx.tenantId(),
            kind: 'INSPECTION_EVIDENCE',
            visibility: 'PRIVATE',
            status: 'READY',
            storageKey,
            mime: 'image/jpeg',
            sizeBytes: photo.data.length,
            width: photo.width,
            height: photo.height,
            checksumSha256: createHash('sha256').update(photo.data).digest(),
            uploadedByKind: actor.kind,
            uploadedById: actor.id,
          },
        });
        await tx.vehicleInspectionEvidence.create({
          data: { tenantId: this.ctx.tenantId(), inspectionId: id, itemId, fileAssetId: fileId },
        });
        return this.detail(tx, id);
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async removePhoto(id: string, photoId: string): Promise<InspectionDetail> {
    if (!UUID.safeParse(photoId).success) throw NOT_FOUND();
    let key = '';
    const detail = await this.db.transaction(async (tx) => {
      await this.lockDraft(tx, id);
      const photo = await tx.vehicleInspectionEvidence.findFirst({
        where: { id: photoId, inspectionId: id },
        select: { file: { select: { id: true, storageKey: true } } },
      });
      if (!photo) throw NOT_FOUND();
      key = photo.file.storageKey;
      await tx.vehicleInspectionEvidence.delete({ where: { id: photoId } });
      await tx.fileAsset.update({ where: { id: photo.file.id }, data: { status: 'DELETED' } });
      return this.detail(tx, id);
    });
    await this.storage.delete(key).catch(() => undefined);
    return detail;
  }

  /** La foto, para verla (solo con sesión y permiso; nunca pública). */
  async photo(id: string, photoId: string) {
    if (!UUID.safeParse(id).success || !UUID.safeParse(photoId).success) throw NOT_FOUND();
    const row = await this.db.transaction((tx) =>
      tx.vehicleInspectionEvidence.findFirst({
        where: { id: photoId, inspectionId: id },
        select: { file: { select: { storageKey: true, status: true } } },
      }),
    );
    if (!row || row.file.status !== 'READY') throw NOT_FOUND();
    const object = await this.storage.get(row.file.storageKey);
    if (!object) throw NOT_FOUND();
    return { body: object.body, mime: 'image/jpeg', filename: `inspeccion-${photoId}.jpg` };
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async lockDraft(tx: Tx, id: string): Promise<void> {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const [row] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM vehicle_inspections WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw NOT_FOUND();
    if (row.status !== 'DRAFT') throw conflict(COMPLETED_MSG);
  }

  private async checkPhotoSlot(tx: Tx, id: string, itemId: string | null): Promise<void> {
    await this.lockDraft(tx, id);
    if (itemId !== null) {
      const item = await tx.vehicleInspectionItem.findFirst({
        where: { id: itemId, inspectionId: id },
        select: { id: true },
      });
      if (!item) throw invalid('El elemento no es de esta inspección');
    }
    const count = await tx.vehicleInspectionEvidence.count({ where: { inspectionId: id, itemId } });
    const max = itemId === null ? EQUIPMENT_LIMITS.photosGeneral : EQUIPMENT_LIMITS.photosPerItem;
    if (count >= max) {
      throw invalid(`Hasta ${max} fotos ${itemId === null ? 'generales por inspección' : 'por elemento'}`);
    }
  }

  private async detail(tx: Tx, id: string): Promise<InspectionDetail> {
    const row = await tx.vehicleInspection.findFirst({
      where: { id },
      include: {
        ...SUMMARY_INCLUDE,
        items: { orderBy: { seq: 'asc' } },
        evidence: { orderBy: { createdAt: 'asc' }, select: { id: true, itemId: true, createdAt: true } },
      },
    });
    if (!row) throw NOT_FOUND();
    const [summary] = await this.summaries([row], tx);
    return {
      ...(summary as InspectionSummary),
      vehicleRegistration: row.vehicleRegistration,
      generalNotes: row.generalNotes,
      rectificationReason: row.rectificationReason,
      items: row.items.map((i) => ({
        id: i.id,
        seq: i.seq,
        vehicleEquipmentId: i.vehicleEquipmentId,
        name: i.name,
        category: i.category,
        declaredQuantity: i.declaredQuantity,
        declaredStatus: i.declaredStatus,
        serialNumber: i.serialNumber,
        expiresOn: isoDate(i.expiresOn),
        result: i.result,
        foundQuantity: i.foundQuantity,
        observation: i.observation,
      })),
      photos: row.evidence.map((e) => ({ id: e.id, itemId: e.itemId, createdAt: e.createdAt.toISOString() })),
      disclaimer: INSPECTION_DISCLAIMER,
    };
  }

  /** Resúmenes con el nombre de quien inició y completó (membresías de esta empresa; RLS). */
  private async summaries(rows: SummaryRow[], tx?: Tx): Promise<InspectionSummary[]> {
    const ids = [
      ...new Set(
        rows.flatMap((r) => [
          ...(r.startedByKind === 'MEMBERSHIP' ? [r.startedById] : []),
          ...(r.completedByKind === 'MEMBERSHIP' && r.completedById ? [r.completedById] : []),
        ]),
      ),
    ];
    const load = (t: Tx) =>
      t.tenantMembership.findMany({ where: { id: { in: ids } }, select: { id: true, userId: true } });
    const members = ids.length === 0 ? [] : tx ? await load(tx) : await this.db.transaction(load);
    const people = await this.directory.describe(members.map((m) => m.userId));
    const userOf = new Map(members.map((m) => [m.id, m.userId]));
    const actor = (kind: string | null, id: string | null) => {
      if (!kind || !id) return null;
      if (kind === 'PLATFORM_USER') return { kind: 'PLATFORM_USER' as const, id, name: 'Soporte de YEBO' };
      return { kind: 'MEMBERSHIP' as const, id, name: people.get(userOf.get(id) ?? '')?.fullName ?? null };
    };
    return rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicleId,
      vehicleCode: r.vehicleCode,
      vehicleName: r.vehicleName,
      trip: r.trip,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      startedBy: actor(r.startedByKind, r.startedById) as InspectionSummary['startedBy'],
      completedAt: r.completedAt?.toISOString() ?? null,
      completedBy: actor(r.completedByKind, r.completedById),
      counts:
        r.conformingCount === null
          ? null
          : {
              conforming: r.conformingCount,
              observed: r.observedCount ?? 0,
              notOperational: r.notOperationalCount ?? 0,
              notAvailable: r.notAvailableCount ?? 0,
            },
      items: r._count.items,
      rectifiesId: r.rectifiesId,
      rectifiedBy: r.rectifiedBy.map((x) => x.id),
    }));
  }
}

/** Foto recodificada a JPEG, orientada y sin metadatos (EXIF, ubicación), con el lado mayor acotado. */
async function jpeg(input: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const bad = () => invalid('La foto debe ser un JPEG, PNG o WebP válido');
  const meta = await sharp(input, { failOn: 'error', limitInputPixels: false })
    .metadata()
    .catch(() => {
      throw bad();
    });
  if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '') || !meta.width || !meta.height) throw bad();
  if (meta.width * meta.height > PHOTO_MAX_PIXELS)
    throw invalid('La foto tiene demasiados píxeles (máximo 50 millones)');
  const { data, info } = await sharp(input, { failOn: 'error', limitInputPixels: PHOTO_MAX_PIXELS })
    .rotate()
    .resize({ width: PHOTO_MAX_SIDE, height: PHOTO_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer({ resolveWithObject: true })
    .catch(() => {
      throw invalid('La foto está dañada o no se puede leer');
    });
  return { data, width: info.width, height: info.height };
}
