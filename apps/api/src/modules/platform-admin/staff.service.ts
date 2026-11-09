import { Inject, Injectable } from '@nestjs/common';
import type { PlatformStaffMember } from '@yebo/contracts';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';
import type { PlatformRole } from '../../generated/prisma/client';
import { Clock } from '../identity/clock';
import { BackofficePrismaService } from './backoffice-prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import {
  PlatformAuthService,
  SETUP_TOKEN_TTL_HOURS,
  hashSetupToken,
  ipOf,
  newOpaqueToken,
  type PlatformPrincipal,
  type RequestMeta,
} from './platform-auth.service';

const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);

type Tx = Parameters<Parameters<BackofficePrismaService['client']['$transaction']>[0]>[0];

/**
 * Gestión del staff de YEBO (permiso `platform.staff.manage`). Altas con enlace de configuración de un solo uso
 * (el token viaja en el fragmento `#`, que el navegador no envía al servidor ni en el Referer).
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly db: BackofficePrismaService,
    private readonly auth: PlatformAuthService,
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(): Promise<PlatformStaffMember[]> {
    const rows = await this.db.client.platformUser.findMany({
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
        mfaEnabledAt: true,
        passwordHash: true,
        lastLoginAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      platformUserId: r.id,
      email: r.email,
      fullName: r.fullName,
      role: r.role,
      status: r.status,
      setupCompleted: r.passwordHash !== null,
      mfaEnabled: r.mfaEnabledAt !== null,
      lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
    }));
  }

  async create(
    actor: PlatformPrincipal,
    input: { email: string; fullName: string; role: PlatformRole },
    meta: RequestMeta,
  ): Promise<{ platformUserId: string; setupUrl: string; setupExpiresAt: string }> {
    const email = input.email.trim().toLowerCase();
    return this.db.client.$transaction(async (tx) => {
      const exists = await tx.platformUser.findUnique({ where: { email }, select: { id: true } });
      if (exists) throw new AppError('CONFLICT', 'Ya existe un miembro del staff con ese correo', 409);
      const user = await tx.platformUser.create({
        data: { email, fullName: input.fullName.trim(), role: input.role, createdById: actor.platformUserId },
        select: { id: true },
      });
      const link = await this.issueSetupLink(tx, user.id, actor.platformUserId);
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'staff.created',
          targetType: 'platform_user',
          targetId: user.id,
          detail: { role: input.role },
          ...ipOf(meta),
        },
        tx,
      );
      return { platformUserId: user.id, ...link };
    });
  }

  /** Nuevo enlace de configuración (alta pendiente o restablecimiento). Invalida los anteriores sin usar. */
  async reissueSetupLink(
    actor: PlatformPrincipal,
    platformUserId: string,
    meta: RequestMeta,
  ): Promise<{ setupUrl: string; setupExpiresAt: string }> {
    if (!UUID.safeParse(platformUserId).success) throw NOT_FOUND();
    return this.db.client.$transaction(async (tx) => {
      const user = await tx.platformUser.findUnique({
        where: { id: platformUserId },
        select: { status: true },
      });
      if (!user) throw NOT_FOUND();
      if (user.status !== 'ACTIVE')
        throw new AppError('CONFLICT', 'El miembro del staff está desactivado', 409);
      const link = await this.issueSetupLink(tx, platformUserId, actor.platformUserId);
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'staff.setup_link_issued',
          targetType: 'platform_user',
          targetId: platformUserId,
          ...ipOf(meta),
        },
        tx,
      );
      return link;
    });
  }

  /**
   * Desactiva a un miembro del staff y cierra sus sesiones en la misma transacción. Nadie puede desactivarse a sí
   * mismo, y nunca puede quedar el sistema sin un superadmin activo.
   */
  async disable(actor: PlatformPrincipal, platformUserId: string, meta: RequestMeta): Promise<number> {
    if (!UUID.safeParse(platformUserId).success) throw NOT_FOUND();
    if (platformUserId === actor.platformUserId) {
      throw new AppError('FORBIDDEN', 'No puedes desactivar tu propia cuenta', 403);
    }
    return this.db.client.$transaction(async (tx) => {
      // Serializa las desactivaciones: la comprobación del último superadmin no admite carreras.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform_staff_disable'))`;
      const user = await tx.platformUser.findUnique({
        where: { id: platformUserId },
        select: { role: true, status: true },
      });
      if (!user) throw NOT_FOUND();
      if (user.status !== 'ACTIVE') throw new AppError('CONFLICT', 'Ya está desactivado', 409);
      if (user.role === 'SUPERADMIN') {
        const others = await tx.platformUser.count({
          where: { role: 'SUPERADMIN', status: 'ACTIVE', id: { not: platformUserId } },
        });
        if (others === 0)
          throw new AppError('CONFLICT', 'No puede quedar el sistema sin un superadmin activo', 409);
      }
      await tx.platformUser.update({ where: { id: platformUserId }, data: { status: 'DISABLED' } });
      const revoked = await this.auth.revokeSessions(tx, { platformUserId }, 'USER_DISABLED');
      await this.audit.record(
        {
          platformUserId: actor.platformUserId,
          action: 'staff.disabled',
          targetType: 'platform_user',
          targetId: platformUserId,
          detail: { revokedSessions: revoked },
          ...ipOf(meta),
        },
        tx,
      );
      return revoked;
    });
  }

  private async issueSetupLink(
    tx: Tx,
    platformUserId: string,
    issuedById: string | null,
  ): Promise<{ setupUrl: string; setupExpiresAt: string }> {
    const now = this.clock.now();
    await tx.platformSetupToken.updateMany({
      where: { platformUserId, consumedAt: null },
      data: { consumedAt: now },
    });
    const token = newOpaqueToken();
    const expiresAt = new Date(now.getTime() + SETUP_TOKEN_TTL_HOURS * 3_600_000);
    await tx.platformSetupToken.create({
      data: {
        platformUserId,
        tokenHash: new Uint8Array(hashSetupToken(token)),
        expiresAt,
        issuedById,
        createdAt: now,
      },
    });
    return {
      setupUrl: `https://${this.env.PLATFORM_ADMIN_HOST}/configurar#token=${token}`,
      setupExpiresAt: expiresAt.toISOString(),
    };
  }
}

/**
 * Alta del PRIMER superadmin (comando `platform:bootstrap`). Solo funciona si no existe ningún miembro del staff:
 * después, las altas se hacen desde el panel con enlace de configuración. La MFA se activa en el primer acceso.
 */
export async function bootstrapSuperadmin(
  db: BackofficePrismaService['client'],
  input: { email: string; fullName: string; passwordHash: string },
): Promise<string> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform_bootstrap'))`;
    if ((await tx.platformUser.count()) > 0) {
      throw new Error(
        'Ya existe staff de plataforma: las altas se hacen desde el panel (platform.staff.manage)',
      );
    }
    const now = new Date();
    const user = await tx.platformUser.create({
      data: {
        email: input.email.trim().toLowerCase(),
        fullName: input.fullName.trim(),
        role: 'SUPERADMIN',
        passwordHash: input.passwordHash,
        passwordChangedAt: now,
      },
      select: { id: true },
    });
    await tx.platformAuditLog.create({
      data: {
        platformUserId: user.id,
        action: 'staff.bootstrapped',
        targetType: 'platform_user',
        targetId: user.id,
      },
    });
    return user.id;
  });
}
