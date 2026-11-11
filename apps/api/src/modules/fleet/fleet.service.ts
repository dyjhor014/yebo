import { Injectable } from '@nestjs/common';
import {
  NominalCapacitySchema,
  documentsSummary,
  type CreateVehicleRequest,
  type Modality,
  type UpdateVehicleRequest,
  type UpdateVehicleTypeRequest,
  type Vehicle,
  type VehicleType,
  type VehicleTypeInput,
  type VehicleTypesResponse,
} from '@yebo/contracts';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { Prisma } from '../../generated/prisma/client';
import { FleetContext } from './fleet-context';

const UUID = z.uuid();
export const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
type Tx = Parameters<Parameters<TenantDbService['transaction']>[0]>[0];

/**
 * Columnas de la restricción única que provocó un P2002, como texto, o `null` si no es un P2002. Según el motor, Prisma
 * las informa en `meta.target` o dentro del error del adaptador (`meta.driverAdapterError`): se busca en todo `meta`.
 */
function uniqueTarget(e: unknown): string | null {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return null;
  return JSON.stringify(e.meta ?? {});
}

const MODALITY_NAME: Record<Modality, string> = { LAND: 'terrestre', RIVER: 'fluvial' };

/**
 * Tipos de vehículo y vehículos de la empresa del host (Fase 6.2; data-dictionary §4; F6-Q3). Con `yebo_app` y el
 * tenant del contexto (RLS forzado): un id de otra empresa no existe.
 * - Un tipo es de una modalidad que la empresa opera; su modalidad no cambia. El vehículo la hereda (FK compuesta) y
 *   solo cambia de tipo dentro de la misma modalidad.
 * - Un tipo no se archiva mientras tenga vehículos no retirados; un vehículo nuevo o editado va a un tipo activo.
 * - Un vehículo se retira (RETIRED), no se borra. El código no cambia; la placa o matrícula es única en la empresa.
 */
@Injectable()
export class FleetService {
  constructor(
    private readonly db: TenantDbService,
    private readonly ctx: FleetContext,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // Tipos
  // ---------------------------------------------------------------------------------------------------------------

  async types(): Promise<VehicleTypesResponse> {
    return this.db.transaction(async (tx) => {
      const catalog = await tx.vehicleTypeCatalog.findMany({ orderBy: { sortOrder: 'asc' } });
      const rows = await tx.vehicleType.findMany({
        orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        include: { _count: { select: { vehicles: { where: { status: { not: 'RETIRED' } } } } } },
      });
      return {
        catalog: catalog.map((c) => ({ code: c.code, name: c.name, modality: c.modality })),
        types: rows.map((r) => toType(r, r._count.vehicles)),
      };
    });
  }

  async createType(input: VehicleTypeInput): Promise<VehicleType> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.assertModality(tx, input.modality);
        await this.assertCatalog(tx, input.catalogCode, input.modality);
        const row = await tx.vehicleType.create({
          data: {
            tenantId: this.ctx.tenantId(),
            name: input.name,
            modality: input.modality,
            catalogCode: input.catalogCode,
          },
        });
        return toType(row, 0);
      });
    } catch (e) {
      if (uniqueTarget(e) !== null) throw duplicateType(input.name);
      throw e;
    }
  }

  async updateType(id: string, input: UpdateVehicleTypeRequest): Promise<VehicleType> {
    try {
      return await this.db.transaction(async (tx) => {
        const current = await this.findType(tx, id);
        await this.assertCatalog(tx, input.catalogCode, current.modality);
        const row = await tx.vehicleType.update({
          where: { id },
          data: { name: input.name, catalogCode: input.catalogCode },
          include: { _count: { select: { vehicles: { where: { status: { not: 'RETIRED' } } } } } },
        });
        return toType(row, row._count.vehicles);
      });
    } catch (e) {
      if (uniqueTarget(e) !== null) throw duplicateType(input.name);
      throw e;
    }
  }

  async archiveType(id: string, archived: boolean): Promise<VehicleType> {
    return this.db.transaction(async (tx) => {
      await this.lockType(tx, id);
      const active = await tx.vehicle.count({ where: { vehicleTypeId: id, status: { not: 'RETIRED' } } });
      if (archived && active > 0) {
        throw new AppError(
          'CONFLICT',
          `El tipo tiene ${active === 1 ? 'un vehículo' : `${active} vehículos`} sin retirar: retíralos o cámbialos de tipo antes`,
          409,
        );
      }
      const row = await tx.vehicleType.update({
        where: { id },
        data: { archivedAt: archived ? this.ctx.now() : null },
      });
      return toType(row, active);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Vehículos
  // ---------------------------------------------------------------------------------------------------------------

  async vehicles(): Promise<Vehicle[]> {
    const today = this.ctx.today();
    const rows = await this.db.transaction((tx) =>
      tx.vehicle.findMany({
        orderBy: [{ code: 'asc' }],
        include: VEHICLE_INCLUDE,
      }),
    );
    return rows.map((r) => toVehicle(r, today));
  }

  async createVehicle(input: CreateVehicleRequest): Promise<Vehicle> {
    try {
      const row = await this.db.transaction(async (tx) => {
        const type = await this.activeType(tx, input.vehicleTypeId);
        return tx.vehicle.create({
          data: {
            tenantId: this.ctx.tenantId(),
            code: input.code,
            ...vehicleData(input),
            modality: type.modality,
          },
          include: VEHICLE_INCLUDE,
        });
      });
      return toVehicle(row, this.ctx.today());
    } catch (e) {
      throw duplicateVehicle(e, input) ?? e;
    }
  }

  async updateVehicle(id: string, input: UpdateVehicleRequest): Promise<Vehicle> {
    try {
      const row = await this.db.transaction(async (tx) => {
        const current = await this.findVehicle(tx, id);
        if (input.vehicleTypeId !== current.vehicleTypeId) {
          const type = await this.activeType(tx, input.vehicleTypeId);
          if (type.modality !== current.modality) {
            throw new AppError(
              'VALIDATION_FAILED',
              `El vehículo es ${MODALITY_NAME[current.modality]}: elige un tipo de la misma modalidad`,
              400,
            );
          }
        }
        return tx.vehicle.update({ where: { id }, data: vehicleData(input), include: VEHICLE_INCLUDE });
      });
      return toVehicle(row, this.ctx.today());
    } catch (e) {
      throw duplicateVehicle(e, input) ?? e;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** La empresa opera esa modalidad (algún servicio activo en tenant_services). */
  private async assertModality(tx: Tx, modality: Modality): Promise<void> {
    const operated = await tx.tenantService.count({ where: { modality, enabled: true } });
    if (operated === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `La empresa no opera servicios de transporte ${MODALITY_NAME[modality]}`,
        400,
      );
    }
  }

  private async assertCatalog(tx: Tx, code: string | null, modality: Modality): Promise<void> {
    if (code === null) return;
    const row = await tx.vehicleTypeCatalog.findUnique({ where: { code }, select: { modality: true } });
    if (!row) throw new AppError('VALIDATION_FAILED', 'Ese tipo no está en el catálogo', 400);
    if (row.modality !== modality) {
      throw new AppError('VALIDATION_FAILED', 'La sugerencia del catálogo es de otra modalidad', 400);
    }
  }

  private async findType(tx: Tx, id: string) {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const row = await tx.vehicleType.findFirst({ where: { id }, select: { id: true, modality: true } });
    if (!row) throw NOT_FOUND();
    return row;
  }

  private async lockType(tx: Tx, id: string): Promise<void> {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM vehicle_types WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw NOT_FOUND();
  }

  /** El tipo existe en esta empresa y no está archivado; se bloquea en modo compartido hasta el final. */
  private async activeType(tx: Tx, id: string): Promise<{ modality: Modality }> {
    const [row] = await tx.$queryRaw<{ modality: Modality; archived: boolean }[]>`
      SELECT modality::text AS modality, archived_at IS NOT NULL AS archived
        FROM vehicle_types WHERE id = ${id}::uuid FOR SHARE`;
    if (!row) throw new AppError('VALIDATION_FAILED', 'El tipo de vehículo no existe', 400);
    if (row.archived) throw new AppError('VALIDATION_FAILED', 'El tipo de vehículo está archivado', 400);
    return { modality: row.modality };
  }

  private async findVehicle(tx: Tx, id: string) {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const row = await tx.vehicle.findFirst({
      where: { id },
      select: { id: true, vehicleTypeId: true, modality: true },
    });
    if (!row) throw NOT_FOUND();
    return row;
  }
}

const VEHICLE_INCLUDE = {
  type: { select: { name: true } },
  documents: { where: { archivedAt: null }, select: { typeCode: true, expiresOn: true } },
} as const;

function duplicateType(name: string) {
  return new AppError('CONFLICT', `Ya existe un tipo de vehículo llamado «${name}»`, 409);
}

function duplicateVehicle(e: unknown, input: { registration: string; code?: string }): AppError | null {
  const target = uniqueTarget(e);
  if (target === null) return null;
  return target.includes('registration_id')
    ? new AppError('CONFLICT', `Ya hay un vehículo con la placa o matrícula ${input.registration}`, 409)
    : new AppError('CONFLICT', `Ya hay un vehículo con el código ${input.code ?? ''}`, 409);
}

function vehicleData(input: UpdateVehicleRequest) {
  return {
    name: input.name,
    vehicleTypeId: input.vehicleTypeId,
    registrationId: input.registration,
    status: input.status,
    ownership: input.ownership,
    nominalCapacity: input.nominalCapacity,
    features: input.features,
  };
}

/** `AAAA-MM-DD` de una columna DATE (Prisma la entrega como medianoche UTC). */
export const isoDate = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

function toType(
  r: { id: string; name: string; modality: Modality; catalogCode: string | null; archivedAt: Date | null },
  activeVehicles: number,
): VehicleType {
  return {
    id: r.id,
    name: r.name,
    modality: r.modality,
    catalogCode: r.catalogCode,
    archived: r.archivedAt !== null,
    activeVehicles,
  };
}

type VehicleRow = Prisma.VehicleGetPayload<{ include: typeof VEHICLE_INCLUDE }>;

function toVehicle(r: VehicleRow, today: string): Vehicle {
  const capacity = NominalCapacitySchema.safeParse(r.nominalCapacity);
  const { summary, nextExpiry } = documentsSummary(
    r.documents.map((d) => ({ typeCode: d.typeCode, expiresOn: isoDate(d.expiresOn) })),
    today,
  );
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    vehicleTypeId: r.vehicleTypeId,
    vehicleTypeName: r.type.name,
    modality: r.modality,
    registration: r.registrationId,
    status: r.status,
    ownership: r.ownership,
    nominalCapacity: capacity.success ? capacity.data : { passengers: null, weightKg: null, volumeM3: null },
    features: Array.isArray(r.features) ? r.features.filter((f): f is string => typeof f === 'string') : [],
    documents: summary,
    nextExpiry,
  };
}
