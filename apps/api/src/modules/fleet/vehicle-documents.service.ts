import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  documentStatus,
  type VehicleDocument,
  type VehicleDocumentFile,
  type VehicleDocumentInput,
  type VehicleDocumentsResponse,
} from '@yebo/contracts';
import sharp from 'sharp';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { ObjectStorage } from '../../infrastructure/storage/object-storage';
import { Prisma } from '../../generated/prisma/client';
import { FleetContext } from './fleet-context';
import { NOT_FOUND, isoDate } from './fleet.service';

const UUID = z.uuid();
type Tx = Parameters<Parameters<TenantDbService['transaction']>[0]>[0];

/** F6-Q5: PDF, JPEG o PNG de hasta 10 MB. */
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;
const MAX_SIDE = 4000;
type DocMime = VehicleDocumentFile['mime'];

/**
 * Documentos de los vehículos (Fase 6.2; F6-Q5): número, emisión, vencimiento y un archivo PRIVADO opcional.
 * - El tipo debe aplicar a la modalidad del vehículo (SOAT, terrestre; certificado de matrícula, fluvial…) y no
 *   cambia. Una renovación es un documento nuevo; el anterior queda como historia (documentsSummary lo resuelve).
 *   Un documento cargado por error se archiva.
 * - Archivos: se comprueban por su CONTENIDO (no por la cabecera ni el nombre). Las imágenes se recodifican sin
 *   metadatos; un PDF se guarda tal cual y solo se entrega como descarga (`attachment`, CSP `sandbox`, `nosniff`),
 *   nunca en línea ni por una URL pública. Un archivo es de un solo documento; al reemplazarlo, el anterior se retira.
 */
@Injectable()
export class VehicleDocumentsService {
  constructor(
    private readonly db: TenantDbService,
    private readonly ctx: FleetContext,
    private readonly storage: ObjectStorage,
  ) {}

  async list(vehicleId: string): Promise<VehicleDocumentsResponse> {
    const today = this.ctx.today();
    return this.db.transaction(async (tx) => {
      const vehicle = await this.findVehicle(tx, vehicleId);
      const types = await tx.vehicleDocumentType.findMany({
        where: { OR: [{ modality: null }, { modality: vehicle.modality }] },
        orderBy: { sortOrder: 'asc' },
      });
      const rows = await tx.vehicleDocument.findMany({
        where: { vehicleId },
        orderBy: [
          { archivedAt: { sort: 'asc', nulls: 'first' } },
          { expiresOn: { sort: 'desc', nulls: 'first' } },
        ],
        include: DOC_INCLUDE,
      });
      return {
        types: types.map((t) => ({ code: t.code, name: t.name })),
        documents: rows.map((r) => toDocument(r, today)),
      };
    });
  }

  async create(vehicleId: string, input: VehicleDocumentInput): Promise<VehicleDocument> {
    const row = await this.write(() =>
      this.db.transaction(async (tx) => {
        const vehicle = await this.findVehicle(tx, vehicleId);
        await this.assertType(tx, input.typeCode, vehicle.modality);
        await this.assertFile(tx, input.fileAssetId);
        return tx.vehicleDocument.create({
          data: {
            tenantId: this.ctx.tenantId(),
            vehicleId,
            typeCode: input.typeCode,
            number: input.number,
            issuedOn: dateOrNull(input.issuedOn),
            expiresOn: dateOrNull(input.expiresOn),
            fileAssetId: input.fileAssetId,
          },
          include: DOC_INCLUDE,
        });
      }),
    );
    return toDocument(row, this.ctx.today());
  }

  async update(vehicleId: string, documentId: string, input: VehicleDocumentInput): Promise<VehicleDocument> {
    const retired: { key?: string } = {};
    const row = await this.write(() =>
      this.db.transaction(async (tx) => {
        const current = await this.findDocument(tx, vehicleId, documentId);
        if (input.typeCode !== current.typeCode) {
          throw new AppError('VALIDATION_FAILED', 'El tipo de un documento no cambia: crea uno nuevo', 400);
        }
        if (input.fileAssetId !== current.fileAssetId) {
          await this.assertFile(tx, input.fileAssetId);
          // El archivo anterior deja de servirse; su objeto se borra tras confirmar.
          if (current.file) {
            await tx.fileAsset.update({ where: { id: current.file.id }, data: { status: 'DELETED' } });
            retired.key = current.file.storageKey;
          }
        }
        return tx.vehicleDocument.update({
          where: { id: documentId },
          data: {
            number: input.number,
            issuedOn: dateOrNull(input.issuedOn),
            expiresOn: dateOrNull(input.expiresOn),
            fileAssetId: input.fileAssetId,
          },
          include: DOC_INCLUDE,
        });
      }),
    );
    if (retired.key) await this.storage.delete(retired.key).catch(() => undefined);
    return toDocument(row, this.ctx.today());
  }

  async archive(vehicleId: string, documentId: string, archived: boolean): Promise<VehicleDocument> {
    const row = await this.db.transaction(async (tx) => {
      await this.findDocument(tx, vehicleId, documentId);
      return tx.vehicleDocument.update({
        where: { id: documentId },
        data: { archivedAt: archived ? this.ctx.now() : null },
        include: DOC_INCLUDE,
      });
    });
    return toDocument(row, this.ctx.today());
  }

  /** Sube un archivo de documento (PDF, JPEG o PNG); se referencia después al crear o editar el documento. */
  async upload(input: unknown): Promise<VehicleDocumentFile> {
    if (!this.storage.enabled) {
      throw new AppError('SERVICE_UNAVAILABLE', 'El almacenamiento de archivos no está configurado', 503);
    }
    if (!Buffer.isBuffer(input) || input.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'Envía el documento como PDF, JPEG o PNG en el cuerpo', 400);
    }
    if (input.length > DOCUMENT_MAX_BYTES) {
      throw new AppError('PAYLOAD_TOO_LARGE', 'El documento pesa más de 10 MB', 413);
    }
    const file = isPdf(input)
      ? { data: input, mime: 'application/pdf' as const, width: null, height: null }
      : await image(input);
    const id = randomUUID();
    const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[file.mime];
    const storageKey = `tenants/${this.ctx.tenantId()}/vehicle-documents/${id}.${ext}`;
    const actor = this.ctx.actor();
    await this.storage.put(storageKey, file.data, file.mime);
    try {
      await this.db.transaction((tx) =>
        tx.fileAsset.create({
          data: {
            id,
            tenantId: this.ctx.tenantId(),
            kind: 'VEHICLE_DOCUMENT',
            visibility: 'PRIVATE',
            status: 'READY',
            storageKey,
            mime: file.mime,
            sizeBytes: file.data.length,
            width: file.width,
            height: file.height,
            checksumSha256: createHash('sha256').update(file.data).digest(),
            uploadedByKind: actor.kind,
            uploadedById: actor.id,
          },
          select: { id: true },
        }),
      );
    } catch (error) {
      await this.storage.delete(storageKey);
      throw error;
    }
    return { id, mime: file.mime, sizeBytes: file.data.length };
  }

  /** El archivo de un documento, para descargarlo (solo con sesión y permiso; nunca público). */
  async download(vehicleId: string, documentId: string) {
    const doc = await this.db.transaction((tx) => this.findDocument(tx, vehicleId, documentId));
    if (!doc.file || doc.file.status !== 'READY') throw NOT_FOUND();
    const object = await this.storage.get(doc.file.storageKey);
    if (!object) throw NOT_FOUND();
    const ext =
      { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[doc.file.mime as DocMime] ??
      'bin';
    const safe = `${doc.typeCode}-${doc.number}`.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
    return { body: object.body, mime: doc.file.mime, filename: `${safe}.${ext}` };
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** Un archivo ya usado por otro documento choca con el UNIQUE (tenant, file_asset_id). */
  private async write<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError('CONFLICT', 'Ese archivo ya está en otro documento', 409);
      }
      throw e;
    }
  }

  private async findVehicle(tx: Tx, id: string) {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const row = await tx.vehicle.findFirst({ where: { id }, select: { id: true, modality: true } });
    if (!row) throw NOT_FOUND();
    return row;
  }

  private async findDocument(tx: Tx, vehicleId: string, documentId: string) {
    if (!UUID.safeParse(vehicleId).success || !UUID.safeParse(documentId).success) throw NOT_FOUND();
    const row = await tx.vehicleDocument.findFirst({
      where: { id: documentId, vehicleId },
      select: {
        typeCode: true,
        number: true,
        fileAssetId: true,
        file: { select: { id: true, storageKey: true, status: true, mime: true } },
      },
    });
    if (!row) throw NOT_FOUND();
    return row;
  }

  private async assertType(tx: Tx, code: string, modality: 'LAND' | 'RIVER'): Promise<void> {
    const type = await tx.vehicleDocumentType.findUnique({ where: { code }, select: { modality: true } });
    if (!type) throw new AppError('VALIDATION_FAILED', 'Ese tipo de documento no existe', 400);
    if (type.modality !== null && type.modality !== modality) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Ese tipo de documento no corresponde a la modalidad del vehículo',
        400,
      );
    }
  }

  /** Un archivo de documento listo de esta empresa (RLS). La unicidad por documento la garantiza la base. */
  private async assertFile(tx: Tx, fileAssetId: string | null): Promise<void> {
    if (fileAssetId === null) return;
    const file = await tx.fileAsset.findFirst({
      where: { id: fileAssetId, kind: 'VEHICLE_DOCUMENT', status: 'READY' },
      select: { id: true },
    });
    if (!file) throw new AppError('VALIDATION_FAILED', 'El archivo no existe o ya no está disponible', 400);
  }
}

const DOC_INCLUDE = {
  type: { select: { name: true } },
  file: { select: { id: true, mime: true, sizeBytes: true, status: true } },
} as const;

type DocRow = Prisma.VehicleDocumentGetPayload<{ include: typeof DOC_INCLUDE }>;

function toDocument(r: DocRow, today: string): VehicleDocument {
  const expiresOn = isoDate(r.expiresOn);
  return {
    id: r.id,
    typeCode: r.typeCode,
    typeName: r.type.name,
    number: r.number,
    issuedOn: isoDate(r.issuedOn),
    expiresOn,
    status: documentStatus(expiresOn, today),
    file:
      r.file && r.file.status === 'READY'
        ? { id: r.file.id, mime: r.file.mime as DocMime, sizeBytes: r.file.sizeBytes }
        : null,
    archived: r.archivedAt !== null,
  };
}

const dateOrNull = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);

/** Un PDF de verdad: empieza por la firma `%PDF-` y termina con `%%EOF` (en su último kilobyte). */
function isPdf(buf: Buffer): boolean {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return false;
  if (
    !buf
      .subarray(Math.max(0, buf.length - 1024))
      .toString('latin1')
      .includes('%%EOF')
  ) {
    throw new AppError('VALIDATION_FAILED', 'El PDF está incompleto o dañado', 400);
  }
  return true;
}

/** JPEG o PNG: se valida por el contenido y se recodifica en el mismo formato, sin metadatos y con su orientación. */
async function image(
  input: Buffer,
): Promise<{ data: Buffer; mime: 'image/jpeg' | 'image/png'; width: number; height: number }> {
  const bad = () => new AppError('VALIDATION_FAILED', 'El documento debe ser un PDF, JPEG o PNG válido', 400);
  const meta = await sharp(input, { failOn: 'error', limitInputPixels: false })
    .metadata()
    .catch(() => {
      throw bad();
    });
  if ((meta.format !== 'jpeg' && meta.format !== 'png') || !meta.width || !meta.height) throw bad();
  if (meta.width * meta.height > MAX_PIXELS) {
    throw new AppError('VALIDATION_FAILED', 'La imagen tiene demasiados píxeles (máximo 50 millones)', 400);
  }
  const pipeline = sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
  const encoded =
    meta.format === 'png' ? pipeline.png({ compressionLevel: 9 }) : pipeline.jpeg({ quality: 85 });
  const { data, info } = await encoded.toBuffer({ resolveWithObject: true }).catch(() => {
    throw new AppError('VALIDATION_FAILED', 'La imagen está dañada o no se puede leer', 400);
  });
  // Un PNG recodificado puede crecer: el límite vale para lo que se guarda (la base lo exige igual).
  if (data.length > DOCUMENT_MAX_BYTES) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      'La imagen procesada pesa más de 10 MB: usa JPEG o una resolución menor',
      413,
    );
  }
  return {
    data,
    mime: meta.format === 'png' ? 'image/png' : 'image/jpeg',
    width: info.width,
    height: info.height,
  };
}
