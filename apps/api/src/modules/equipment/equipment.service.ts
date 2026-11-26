import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  EQUIPMENT_LIMITS,
  INSPECTION_DISCLAIMER,
  type AddVehicleEquipmentRequest,
  type EquipmentCatalogResponse,
  type TenantEquipmentItemRequest,
  type UpdateVehicleEquipmentRequest,
  type VehicleEquipment,
} from '@yebo/contracts';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { FleetContext } from '../fleet/fleet-context';

type Tx = Parameters<Parameters<TenantDbService['transaction']>[0]>[0];
const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, 400);
const day = (d: string) => new Date(`${d}T00:00:00Z`);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
/** Días antes del vencimiento en que un elemento pasa a «por vencer» (como los documentos de la 6.2). */
const EXPIRING_DAYS = 30;

/**
 * Equipamiento de las unidades y catálogo (Fase 7.E1; EQ-Q3, EQ-Q6). Todo con `yebo_app` y el tenant del contexto.
 * - El catálogo de YEBO son sugerencias con una referencia normativa orientativa; el de la empresa, sus propios
 *   elementos. Ninguno es una lista de obligatorios: una unidad sin equipamiento es válida.
 * - Cada unidad guarda sus propios datos de cada elemento (aunque venga del catálogo). «Eliminar» = archivar: las
 *   inspecciones anteriores conservan su copia.
 */
@Injectable()
export class EquipmentService {
  constructor(
    private readonly db: TenantDbService,
    private readonly ctx: FleetContext,
  ) {}

  async catalog(): Promise<EquipmentCatalogResponse> {
    const { global, custom } = await this.db.transaction(async (tx) => ({
      global: await tx.equipmentCatalogItem.findMany({ orderBy: { sortOrder: 'asc' } }),
      custom: await tx.tenantEquipmentItem.findMany({
        orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
      }),
    }));
    return {
      disclaimer: INSPECTION_DISCLAIMER,
      entries: [
        ...global.map((g) => ({
          source: 'CATALOG' as const,
          ref: g.code,
          name: g.name,
          modality: g.modality,
          category: g.category,
          tracksExpiry: g.tracksExpiry,
          tracksSerial: g.tracksSerial,
          reference: g.reference,
          description: null,
          archived: false,
        })),
        ...custom.map((c) => ({
          source: 'TENANT' as const,
          ref: c.id,
          name: c.name,
          modality: c.modality,
          category: c.category,
          tracksExpiry: c.tracksExpiry,
          tracksSerial: c.tracksSerial,
          reference: null,
          description: c.description,
          archived: c.archivedAt !== null,
        })),
      ],
    };
  }

  async createItem(input: TenantEquipmentItemRequest): Promise<EquipmentCatalogResponse> {
    await this.uniqueName(() =>
      this.db.transaction((tx) =>
        tx.tenantEquipmentItem.create({ data: { tenantId: this.ctx.tenantId(), ...input } }),
      ),
    );
    return this.catalog();
  }

  async updateItem(id: string, input: TenantEquipmentItemRequest): Promise<EquipmentCatalogResponse> {
    await this.uniqueName(() =>
      this.db.transaction(async (tx) => {
        await this.findItem(tx, id);
        return tx.tenantEquipmentItem.update({ where: { id }, data: input });
      }),
    );
    return this.catalog();
  }

  async archiveItem(id: string, archived: boolean): Promise<EquipmentCatalogResponse> {
    await this.uniqueName(() =>
      this.db.transaction(async (tx) => {
        await this.findItem(tx, id);
        return tx.tenantEquipmentItem.update({
          where: { id },
          data: { archivedAt: archived ? this.ctx.now() : null },
        });
      }),
    );
    return this.catalog();
  }

  async list(vehicleId: string, includeArchived: boolean): Promise<VehicleEquipment[]> {
    const rows = await this.db.transaction(async (tx) => {
      await this.findVehicle(tx, vehicleId);
      return tx.vehicleEquipment.findMany({
        where: { vehicleId, ...(includeArchived ? {} : { archivedAt: null }) },
        orderBy: [
          { archivedAt: { sort: 'asc', nulls: 'first' } },
          { category: 'asc' },
          { name: 'asc' },
          { id: 'asc' },
        ],
      });
    });
    const today = this.ctx.today();
    return rows.map((r) => toEquipment(r, today));
  }

  /** Declara uno o varios elementos (todos o ninguno). */
  async add(vehicleId: string, input: AddVehicleEquipmentRequest): Promise<VehicleEquipment[]> {
    await this.db.transaction(async (tx) => {
      await this.findVehicle(tx, vehicleId);
      const active = await tx.vehicleEquipment.count({ where: { vehicleId, archivedAt: null } });
      if (active + input.items.length > EQUIPMENT_LIMITS.perVehicle) {
        throw invalid(`Una unidad tiene hasta ${EQUIPMENT_LIMITS.perVehicle} elementos de equipamiento`);
      }
      const codes = [...new Set(input.items.flatMap((i) => (i.catalogCode ? [i.catalogCode] : [])))];
      if (codes.length > 0) {
        const found = await tx.equipmentCatalogItem.count({ where: { code: { in: codes } } });
        if (found !== codes.length) throw invalid('Uno de los elementos no está en el catálogo de YEBO');
      }
      const items = [...new Set(input.items.flatMap((i) => (i.tenantItemId ? [i.tenantItemId] : [])))];
      if (items.length > 0) {
        const found = await tx.tenantEquipmentItem.count({ where: { id: { in: items }, archivedAt: null } });
        if (found !== items.length)
          throw invalid('Uno de los elementos no está en el catálogo de la empresa');
      }
      await tx.vehicleEquipment.createMany({
        data: input.items.map((i) => ({
          tenantId: this.ctx.tenantId(),
          vehicleId,
          catalogCode: i.catalogCode,
          tenantItemId: i.tenantItemId,
          ...fields(i),
        })),
      });
    });
    return this.list(vehicleId, false);
  }

  async update(
    vehicleId: string,
    id: string,
    input: UpdateVehicleEquipmentRequest,
  ): Promise<VehicleEquipment> {
    const row = await this.db.transaction(async (tx) => {
      const current = await this.findEquipment(tx, vehicleId, id);
      if (current.archivedAt) {
        throw new AppError('CONFLICT', 'El elemento fue eliminado de la unidad: agrégalo de nuevo', 409);
      }
      return tx.vehicleEquipment.update({ where: { id }, data: fields(input) });
    });
    return toEquipment(row, this.ctx.today());
  }

  /** «Eliminar» un elemento de la unidad: se archiva; las inspecciones anteriores conservan su copia (EQ-Q6). */
  async remove(vehicleId: string, id: string): Promise<VehicleEquipment> {
    const row = await this.db.transaction(async (tx) => {
      const current = await this.findEquipment(tx, vehicleId, id);
      if (current.archivedAt)
        throw new AppError('CONFLICT', 'El elemento ya fue eliminado de la unidad', 409);
      return tx.vehicleEquipment.update({ where: { id }, data: { archivedAt: this.ctx.now() } });
    });
    return toEquipment(row, this.ctx.today());
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async findVehicle(tx: Tx, id: string) {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const v = await tx.vehicle.findFirst({ where: { id }, select: { id: true } });
    if (!v) throw NOT_FOUND();
  }

  private async findEquipment(tx: Tx, vehicleId: string, id: string) {
    if (!UUID.safeParse(vehicleId).success || !UUID.safeParse(id).success) throw NOT_FOUND();
    const row = await tx.vehicleEquipment.findFirst({
      where: { id, vehicleId },
      select: { archivedAt: true },
    });
    if (!row) throw NOT_FOUND();
    return row;
  }

  private async findItem(tx: Tx, id: string) {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const row = await tx.tenantEquipmentItem.findFirst({ where: { id }, select: { id: true } });
    if (!row) throw NOT_FOUND();
  }

  private async uniqueName<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const text =
        e instanceof Error ? `${e.message} ${JSON.stringify((e as { meta?: unknown }).meta ?? {})}` : '';
      if (
        (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') ||
        /tenant_equipment_items_name_key|23505/.test(text)
      ) {
        throw new AppError(
          'CONFLICT',
          'Ya hay un elemento activo con ese nombre en el catálogo de la empresa',
          409,
        );
      }
      throw e;
    }
  }
}

function fields(i: UpdateVehicleEquipmentRequest) {
  return {
    name: i.name,
    category: i.category,
    quantity: i.quantity,
    description: i.description,
    status: i.status,
    expiresOn: i.expiresOn ? day(i.expiresOn) : null,
    serialNumber: i.serialNumber,
  };
}

type EquipmentRow = Prisma.VehicleEquipmentGetPayload<object>;

function toEquipment(r: EquipmentRow, today: string): VehicleEquipment {
  const expiresOn = r.expiresOn ? isoDate(r.expiresOn) : null;
  let expiry: VehicleEquipment['expiry'] = null;
  if (expiresOn) {
    const soon = new Date(`${today}T00:00:00Z`);
    soon.setUTCDate(soon.getUTCDate() + EXPIRING_DAYS);
    expiry = expiresOn < today ? 'EXPIRED' : expiresOn <= isoDate(soon) ? 'EXPIRING' : 'VALID';
  }
  return {
    id: r.id,
    vehicleId: r.vehicleId,
    catalogCode: r.catalogCode,
    tenantItemId: r.tenantItemId,
    name: r.name,
    category: r.category,
    quantity: r.quantity,
    description: r.description,
    status: r.status,
    expiresOn,
    serialNumber: r.serialNumber,
    expiry,
    archived: r.archivedAt !== null,
  };
}
