import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  LOCATION_KINDS,
  type Branch,
  type CreateBranchRequest,
  type Location,
  type LocationInput,
  type LocationKind,
  type LocationsResponse,
  type SalesChannel,
  type UpdateBranchRequest,
  type UpdateSalesChannelRequest,
} from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { Clock } from '../identity/clock';

const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
type Tx = Parameters<Parameters<TenantDbService['transaction']>[0]>[0];

const isUnique = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Ubicaciones, sucursales y canales de venta de la empresa del host (Fase 6.1; data-dictionary §3; F6-Q4, F6-Q6).
 * Todo con `yebo_app` y el tenant del contexto (RLS forzado): un id de otra empresa no existe (404).
 * - Nada se borra: se archiva. Una ubicación no se archiva con sucursales activas; una sucursal nueva o editada
 *   va a una ubicación activa.
 * - Cada sucursal nace con su mostrador (canal COUNTER) en la misma transacción; al archivarla, el mostrador se
 *   desactiva, y al restaurarla vuelve a estar activo. El canal ONLINE nace con la empresa (alta). Los canales de
 *   agencia (EXTERNAL_AGENCY) los crea el módulo de agencias (Fase 6.5).
 */
@Injectable()
export class LocationsService {
  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // Ubicaciones
  // ---------------------------------------------------------------------------------------------------------------

  async locations(): Promise<LocationsResponse> {
    return this.db.transaction(async (tx) => {
      const kinds = await tx.locationKind.findMany({ orderBy: { sortOrder: 'asc' } });
      const rows = await tx.location.findMany({
        orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        include: { _count: { select: { branches: { where: { archivedAt: null } } } } },
      });
      return {
        kinds: kinds
          .filter((k) => (LOCATION_KINDS as readonly string[]).includes(k.code))
          .map((k) => ({ code: k.code as LocationKind, name: k.name })),
        locations: rows.map((r) => toLocation(r, r._count.branches)),
      };
    });
  }

  async createLocation(input: LocationInput): Promise<Location> {
    try {
      const row = await this.db.transaction((tx) =>
        tx.location.create({ data: { tenantId: this.tenantId(), ...locationData(input) } }),
      );
      return toLocation(row, 0);
    } catch (e) {
      if (isUnique(e)) throw duplicateLocation(input.name);
      throw e;
    }
  }

  async updateLocation(id: string, input: LocationInput): Promise<Location> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.findLocation(tx, id);
        const row = await tx.location.update({
          where: { id },
          data: locationData(input),
          include: { _count: { select: { branches: { where: { archivedAt: null } } } } },
        });
        return toLocation(row, row._count.branches);
      });
    } catch (e) {
      if (isUnique(e)) throw duplicateLocation(input.name);
      throw e;
    }
  }

  async archiveLocation(id: string, archived: boolean): Promise<Location> {
    return this.db.transaction(async (tx) => {
      // Bloquea la ubicación: una sucursal nueva en ella espera (y luego ve la ubicación archivada).
      await this.lockLocation(tx, id);
      const active = await tx.branch.count({ where: { locationId: id, archivedAt: null } });
      if (archived && active > 0) {
        throw new AppError(
          'CONFLICT',
          `La ubicación tiene ${active === 1 ? 'una sucursal activa' : `${active} sucursales activas`}: archívalas o muévelas antes`,
          409,
        );
      }
      const row = await tx.location.update({
        where: { id },
        data: { archivedAt: archived ? this.clock.now() : null },
      });
      return toLocation(row, active);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Sucursales
  // ---------------------------------------------------------------------------------------------------------------

  async branches(): Promise<Branch[]> {
    const rows = await this.db.transaction((tx) =>
      tx.branch.findMany({
        orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { code: 'asc' }],
        include: { location: { select: { name: true } } },
      }),
    );
    return rows.map(toBranch);
  }

  /** La sucursal y su mostrador, en una transacción. */
  async createBranch(input: CreateBranchRequest): Promise<Branch> {
    const tenantId = this.tenantId();
    try {
      return await this.db.transaction(async (tx) => {
        await this.activeLocation(tx, input.locationId);
        const row = await tx.branch.create({
          data: { tenantId, ...branchData(input), code: input.code },
          include: { location: { select: { name: true } } },
        });
        await tx.salesChannel.create({
          data: {
            tenantId,
            code: `MOSTRADOR-${row.code}`,
            // El nombre del canal tiene 80 caracteres como máximo, como el de la sucursal: se recorta.
            name: `Mostrador ${row.name}`.slice(0, 80),
            kind: 'COUNTER',
            branchId: row.id,
          },
          select: { id: true },
        });
        return toBranch(row);
      });
    } catch (e) {
      if (isUnique(e))
        throw new AppError('CONFLICT', `Ya existe una sucursal con el código ${input.code}`, 409);
      throw e;
    }
  }

  async updateBranch(id: string, input: UpdateBranchRequest): Promise<Branch> {
    return this.db.transaction(async (tx) => {
      const current = await this.findBranch(tx, id);
      // Mover una sucursal activa exige una ubicación activa; una archivada puede quedarse donde estaba.
      if (input.locationId !== current.locationId || current.archivedAt === null) {
        await this.activeLocation(tx, input.locationId);
      }
      const row = await tx.branch.update({
        where: { id },
        data: branchData(input),
        include: { location: { select: { name: true } } },
      });
      return toBranch(row);
    });
  }

  async archiveBranch(id: string, archived: boolean): Promise<Branch> {
    return this.db.transaction(async (tx) => {
      const current = await this.findBranch(tx, id);
      if (!archived) await this.activeLocation(tx, current.locationId);
      const row = await tx.branch.update({
        where: { id },
        data: { archivedAt: archived ? this.clock.now() : null },
        include: { location: { select: { name: true } } },
      });
      await tx.salesChannel.updateMany({
        where: { branchId: id, kind: 'COUNTER' },
        data: { isActive: !archived },
      });
      return toBranch(row);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Canales de venta
  // ---------------------------------------------------------------------------------------------------------------

  async channels(): Promise<SalesChannel[]> {
    const rows = await this.db.transaction((tx) =>
      tx.salesChannel.findMany({ orderBy: [{ kind: 'asc' }, { code: 'asc' }] }),
    );
    return rows.map(toChannel);
  }

  async updateChannel(id: string, input: UpdateSalesChannelRequest): Promise<SalesChannel> {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    return this.db.transaction(async (tx) => {
      const current = await tx.salesChannel.findFirst({
        where: { id },
        select: {
          kind: true,
          branch: { select: { archivedAt: true } },
          agency: { select: { archivedAt: true } },
        },
      });
      if (!current) throw NOT_FOUND();
      if (input.isActive && current.branch?.archivedAt) {
        throw new AppError(
          'CONFLICT',
          'El mostrador es de una sucursal archivada: restaura la sucursal',
          409,
        );
      }
      // Fase 6.5: el canal de una agencia archivada tampoco se reactiva.
      if (input.isActive && current.agency?.archivedAt) {
        throw new AppError('CONFLICT', 'El canal es de una agencia archivada: restaura la agencia', 409);
      }
      return toChannel(await tx.salesChannel.update({ where: { id }, data: input }));
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Ámbito de sucursal de una membresía (F6-Q4)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Reemplaza las sucursales de una persona (vacío = todas). Solo sucursales activas. Sube la versión de permisos
   * de la membresía, como un cambio de roles: el ámbito forma parte de lo que puede hacer.
   */
  async assignBranches(membershipId: string, branchIds: readonly string[]): Promise<string[]> {
    if (!UUID.safeParse(membershipId).success) throw NOT_FOUND();
    const tenantId = this.tenantId();
    return this.db.transaction(async (tx) => {
      const [target] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM tenant_memberships WHERE id = ${membershipId}::uuid FOR UPDATE`;
      if (!target) throw NOT_FOUND();
      if (target.status === 'REVOKED') {
        throw new AppError('CONFLICT', 'La membresía está revocada; no se le pueden asignar sucursales', 409);
      }
      const found = await tx.branch.count({ where: { id: { in: [...branchIds] }, archivedAt: null } });
      if (found !== branchIds.length) {
        throw new AppError('VALIDATION_FAILED', 'Alguna sucursal no existe o está archivada', 400);
      }
      await tx.membershipBranchScope.deleteMany({ where: { membershipId } });
      if (branchIds.length > 0) {
        await tx.membershipBranchScope.createMany({
          data: branchIds.map((branchId) => ({ tenantId, membershipId, branchId })),
        });
      }
      await tx.tenantMembership.updateMany({
        where: { id: membershipId },
        data: { permissionsVersion: { increment: 1 } },
      });
      return [...branchIds].sort();
    });
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async findLocation(tx: Tx, id: string) {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const row = await tx.location.findFirst({ where: { id }, select: { id: true, archivedAt: true } });
    if (!row) throw NOT_FOUND();
    return row;
  }

  private async lockLocation(tx: Tx, id: string): Promise<void> {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM locations WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw NOT_FOUND();
  }

  /** La ubicación existe en esta empresa y no está archivada; se bloquea en modo compartido hasta el final. */
  private async activeLocation(tx: Tx, id: string): Promise<void> {
    const [row] = await tx.$queryRaw<{ archived: boolean }[]>`
      SELECT archived_at IS NOT NULL AS archived FROM locations WHERE id = ${id}::uuid FOR SHARE`;
    if (!row) throw new AppError('VALIDATION_FAILED', 'La ubicación no existe', 400);
    if (row.archived) throw new AppError('VALIDATION_FAILED', 'La ubicación está archivada', 400);
  }

  private async findBranch(tx: Tx, id: string) {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const row = await tx.branch.findFirst({
      where: { id },
      select: { id: true, locationId: true, archivedAt: true },
    });
    if (!row) throw NOT_FOUND();
    return row;
  }

  private tenantId(): string {
    const id = this.cls.get('tenantId');
    if (!id) throw new Error('LocationsService requiere el tenant del host');
    return id;
  }
}

function duplicateLocation(name: string) {
  return new AppError('CONFLICT', `Ya existe una ubicación llamada «${name}»`, 409);
}

function locationData(input: LocationInput) {
  return {
    name: input.name,
    kindCode: input.kind,
    ubigeo: input.ubigeo,
    region: input.region,
    lat: input.lat,
    lng: input.lng,
  };
}

function branchData(input: UpdateBranchRequest) {
  return {
    locationId: input.locationId,
    name: input.name,
    address: input.address,
    phones: input.phones,
    isPickupPoint: input.isPickupPoint,
    isReceptionPoint: input.isReceptionPoint,
  };
}

type LocationRow = {
  id: string;
  name: string;
  kindCode: string;
  ubigeo: string | null;
  region: string | null;
  lat: Prisma.Decimal | null;
  lng: Prisma.Decimal | null;
  archivedAt: Date | null;
};

function toLocation(r: LocationRow, activeBranches: number): Location {
  return {
    id: r.id,
    name: r.name,
    kind: r.kindCode as LocationKind,
    ubigeo: r.ubigeo,
    region: r.region,
    lat: r.lat === null ? null : Number(r.lat),
    lng: r.lng === null ? null : Number(r.lng),
    archived: r.archivedAt !== null,
    activeBranches,
  };
}

type BranchRow = {
  id: string;
  code: string;
  name: string;
  locationId: string;
  address: string;
  phones: Prisma.JsonValue;
  isPickupPoint: boolean;
  isReceptionPoint: boolean;
  archivedAt: Date | null;
  location: { name: string };
};

function toBranch(r: BranchRow): Branch {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    locationId: r.locationId,
    locationName: r.location.name,
    address: r.address,
    phones: Array.isArray(r.phones) ? r.phones.filter((p): p is string => typeof p === 'string') : [],
    isPickupPoint: r.isPickupPoint,
    isReceptionPoint: r.isReceptionPoint,
    archived: r.archivedAt !== null,
  };
}

function toChannel(r: {
  id: string;
  code: string;
  name: string;
  kind: SalesChannel['kind'];
  branchId: string | null;
  agencyId: string | null;
  isActive: boolean;
}): SalesChannel {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    branchId: r.branchId,
    agencyId: r.agencyId,
    isActive: r.isActive,
  };
}
