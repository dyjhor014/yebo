import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CreateBlockRequest, TripBlock } from '@yebo/contracts';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { FleetContext } from '../fleet/fleet-context';
import { InventoryService } from './inventory.service';

type Tx = Parameters<Parameters<TenantDbService['transaction']>[0]>[0];
const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);

/**
 * Bloqueos operativos de un viaje (Fase 7.4; F7-Q5): tripulación, mantenimiento, cortesía u otro. Cada bloqueo es el
 * titular (`BLOCK`) de sus asignaciones en el motor de inventario y guarda quién lo crea y quién lo libera. Con
 * vencimiento, sus asignaciones son retenciones (HELD) que se liberan solas cuando alguien necesita ese inventario.
 */
@Injectable()
export class BlocksService {
  constructor(
    private readonly db: TenantDbService,
    private readonly ctx: FleetContext,
    private readonly inventory: InventoryService,
  ) {}

  async list(tripId: string): Promise<TripBlock[]> {
    if (!UUID.safeParse(tripId).success) throw NOT_FOUND();
    return this.db.transaction(async (tx) => {
      const trip = await tx.trip.findFirst({ where: { id: tripId }, select: { id: true } });
      if (!trip) throw NOT_FOUND();
      const rows = await tx.tripBlock.findMany({
        where: { tripId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      return Promise.all(rows.map((r) => this.view(tx, r.id)));
    });
  }

  async create(tripId: string, input: CreateBlockRequest): Promise<TripBlock> {
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt <= this.ctx.now()) {
      throw new AppError('VALIDATION_FAILED', 'El vencimiento es posterior a este momento', 400);
    }
    const id = randomUUID();
    const request = {
      tripId,
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      holderType: 'BLOCK' as const,
      holderId: id,
      resourceCodes: input.resourceCodes,
      pools: input.pools,
      holdExpiresAt: expiresAt,
    };
    // Primero libera las retenciones vencidas que estorban (su propia transacción, como en el motor).
    await this.inventory.releaseExpired(request);
    return this.db.transaction(async (tx) => {
      // El titular primero: asignación y bloqueo se confirman juntos o nada.
      const actor = this.ctx.actor();
      const trip = await tx.trip.findFirst({ where: { id: tripId }, select: { id: true } });
      if (!trip) throw NOT_FOUND();
      await tx.tripBlock.create({
        data: {
          id,
          tenantId: this.ctx.tenantId(),
          tripId,
          reason: input.reason,
          note: input.note,
          fromSeq: input.fromSeq,
          toSeq: input.toSeq,
          expiresAt,
          createdByKind: actor.kind,
          createdById: actor.id,
        },
      });
      await this.inventory.allocateIn(tx, request);
      return this.view(tx, id);
    });
  }

  async release(tripId: string, blockId: string): Promise<TripBlock> {
    if (!UUID.safeParse(tripId).success || !UUID.safeParse(blockId).success) throw NOT_FOUND();
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ released: boolean }[]>`
        SELECT released_at IS NOT NULL AS released FROM trip_blocks
         WHERE id = ${blockId}::uuid AND trip_id = ${tripId}::uuid FOR UPDATE`;
      if (!locked) throw NOT_FOUND();
      if (locked.released) throw new AppError('CONFLICT', 'El bloqueo ya está liberado', 409);
      await this.inventory.releaseIn(tx, [blockId], false);
      const actor = this.ctx.actor();
      await tx.tripBlock.update({
        where: { id: blockId },
        data: { releasedAt: this.ctx.now(), releasedByKind: actor.kind, releasedById: actor.id },
      });
      return this.view(tx, blockId);
    });
  }

  private async view(tx: Tx, id: string): Promise<TripBlock> {
    const b = await tx.tripBlock.findFirstOrThrow({ where: { id } });
    const resources = await tx.$queryRaw<{ code: string }[]>`
      SELECT r.code FROM resource_allocations a JOIN trip_resources r ON r.id = a.trip_resource_id
       WHERE a.holder_id = ${id}::uuid ORDER BY r.code`;
    const pools = await tx.$queryRaw<{ pool_id: string; quantity: string }[]>`
      SELECT pool_id::text, quantity::text FROM pool_allocations WHERE holder_id = ${id}::uuid ORDER BY pool_id`;
    const now = this.ctx.now();
    return {
      id: b.id,
      tripId: b.tripId,
      reason: b.reason,
      note: b.note,
      fromSeq: b.fromSeq,
      toSeq: b.toSeq,
      resourceCodes: resources.map((r) => r.code),
      pools: pools.map((p) => ({ poolId: p.pool_id, quantity: Number(p.quantity) })),
      expiresAt: b.expiresAt?.toISOString() ?? null,
      state: b.releasedAt ? 'RELEASED' : b.expiresAt && b.expiresAt <= now ? 'EXPIRED' : 'ACTIVE',
      createdAt: b.createdAt.toISOString(),
      releasedAt: b.releasedAt?.toISOString() ?? null,
    };
  }
}
