import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type { Agency, CreateAgencyRequest, UpdateAgencyRequest } from '@yebo/contracts';
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

/** El canal de venta de la agencia (el nombre del canal cabe en sus 80 caracteres). */
const channelName = (name: string) => `Agencia ${name}`.slice(0, 80);

const WITH_CHANNEL = {
  channels: { select: { id: true, code: true, isActive: true }, take: 1 },
} as const;

/**
 * Agencias externas de la empresa del host (Fase 6.5; data-dictionary §3; F6-Q2). Las rutas exigen el módulo
 * AGENCIES. Todo con `yebo_app` y el tenant del contexto (RLS forzado): un id de otra empresa no existe (404).
 * - Cada agencia nace con su canal EXTERNAL_AGENCY (código `AGENCIA-<RUC>`) en la misma transacción.
 * - Nada se borra: se archiva. Al archivarla, su canal se desactiva; al restaurarla, vuelve a estar activo.
 * - El RUC es único por empresa (también entre las archivadas: se restaura en vez de repetirla) y no cambia.
 */
@Injectable()
export class AgenciesService {
  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly clock: Clock,
  ) {}

  async agencies(): Promise<Agency[]> {
    const rows = await this.db.transaction((tx) =>
      tx.agency.findMany({
        orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        include: WITH_CHANNEL,
      }),
    );
    return rows.map(toAgency);
  }

  /** La agencia y su canal, en una transacción. */
  async create(input: CreateAgencyRequest): Promise<Agency> {
    const tenantId = this.tenantId();
    try {
      return await this.db.transaction(async (tx) => {
        const row = await tx.agency.create({ data: { tenantId, taxId: input.taxId, ...agencyData(input) } });
        const channel = await tx.salesChannel.create({
          data: {
            tenantId,
            code: `AGENCIA-${row.taxId}`,
            name: channelName(row.name),
            kind: 'EXTERNAL_AGENCY',
            agencyId: row.id,
          },
          select: { id: true, code: true, isActive: true },
        });
        return toAgency({ ...row, channels: [channel] });
      });
    } catch (e) {
      if (isUnique(e)) {
        throw new AppError(
          'CONFLICT',
          `Ya existe una agencia con el RUC ${input.taxId}; si está archivada, restáurala`,
          409,
        );
      }
      throw e;
    }
  }

  async update(id: string, input: UpdateAgencyRequest): Promise<Agency> {
    return this.db.transaction(async (tx) => {
      await this.find(tx, id);
      const row = await tx.agency.update({ where: { id }, data: agencyData(input), include: WITH_CHANNEL });
      return toAgency(row);
    });
  }

  async archive(id: string, archived: boolean): Promise<Agency> {
    return this.db.transaction(async (tx) => {
      await this.find(tx, id);
      await tx.agency.update({ where: { id }, data: { archivedAt: archived ? this.clock.now() : null } });
      await tx.salesChannel.updateMany({
        where: { agencyId: id, kind: 'EXTERNAL_AGENCY' },
        data: { isActive: !archived },
      });
      return toAgency(await tx.agency.findFirstOrThrow({ where: { id }, include: WITH_CHANNEL }));
    });
  }

  private async find(tx: Tx, id: string) {
    if (!UUID.safeParse(id).success) throw NOT_FOUND();
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM agencies WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw NOT_FOUND();
  }

  private tenantId(): string {
    const id = this.cls.get('tenantId');
    if (!id) throw new Error('AgenciesService requiere el tenant del host');
    return id;
  }
}

function agencyData(input: UpdateAgencyRequest) {
  return {
    name: input.name,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    contactEmail: input.contactEmail,
  };
}

type AgencyRow = {
  id: string;
  name: string;
  taxId: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  archivedAt: Date | null;
  channels: { id: string; code: string; isActive: boolean }[];
};

function toAgency(r: AgencyRow): Agency {
  const channel = r.channels[0];
  if (!channel) throw new Error(`La agencia ${r.id} no tiene su canal de venta`);
  return {
    id: r.id,
    name: r.name,
    taxId: r.taxId,
    contactName: r.contactName,
    contactPhone: r.contactPhone,
    contactEmail: r.contactEmail,
    archived: r.archivedAt !== null,
    channel,
  };
}
