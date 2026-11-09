import { Inject, Injectable } from '@nestjs/common';
import type { CreateInvitationRequest, Invitation, InvitationLink } from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { Clock } from '../identity/clock';
import { INVITATION_TTL_MS, invitationLink, newInvitationToken } from '../identity/invitation-token';

const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);

/**
 * Invitaciones de la empresa del host (Fase 4.3b; multitenancy §1.1). Con `yebo_app` y RLS.
 * - Invitar NO consulta si existe una cuenta con ese correo: la respuesta es idéntica en ambos casos.
 * - El enlace (un solo uso, 72 h) se devuelve UNA vez a quien invita (F4-Q3); en la base queda solo su hash.
 * - Los roles deben ser de esta empresa y no estar archivados.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async create(input: CreateInvitationRequest): Promise<InvitationLink> {
    const tenantId = this.cls.get('tenantId');
    const principal = this.cls.get('principal');
    const support = this.cls.get('supportPrincipal');
    if (!tenantId || (!principal && !support))
      throw new Error('InvitationsService requiere tenant y sesión verificada');
    const now = this.clock.now();
    const { token, hash } = newInvitationToken(tenantId);
    return this.db.transaction(async (tx) => {
      const roles = await tx.role.findMany({
        where: { id: { in: input.roleIds }, archivedAt: null },
        select: { id: true },
      });
      if (roles.length !== input.roleIds.length) {
        throw new AppError('VALIDATION_FAILED', 'Algún rol no existe en esta empresa', 400);
      }
      const row = await tx.membershipInvitation.create({
        data: {
          tenantId,
          email: input.email,
          roleIds: input.roleIds,
          tokenHash: new Uint8Array(hash),
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
          // Fase 4.6: una invitación hecha por el staff de soporte queda a nombre del staff.
          ...(support
            ? { invitedByPlatformUserId: support.platformUserId }
            : { invitedByMembershipId: principal?.membershipId ?? null }),
          createdAt: now,
        },
        select: { id: true, email: true, expiresAt: true },
      });
      return {
        id: row.id,
        email: row.email,
        expiresAt: row.expiresAt.toISOString(),
        link: invitationLink(this.env.AUTH_HUB_HOST, token),
      };
    });
  }

  async list(): Promise<Invitation[]> {
    const now = this.clock.now();
    const rows = await this.db.client.membershipInvitation.findMany({
      select: {
        id: true,
        email: true,
        roleIds: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      roleIds: r.roleIds,
      status: r.acceptedAt
        ? 'ACCEPTED'
        : r.revokedAt
          ? 'REVOKED'
          : r.expiresAt <= now
            ? 'EXPIRED'
            : 'PENDING',
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Revoca una invitación pendiente (aceptada o ya revocada → 404). */
  async revoke(invitationId: string): Promise<void> {
    if (!UUID.safeParse(invitationId).success) throw NOT_FOUND();
    const done = await this.db.client.membershipInvitation.updateMany({
      where: { id: invitationId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
    if (done.count !== 1) throw NOT_FOUND();
  }
}
