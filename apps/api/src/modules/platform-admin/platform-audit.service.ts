import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { BackofficePrismaService } from './backoffice-prisma.service';

export interface AuditEntry {
  platformUserId: string | null;
  /** `dominio.verbo` en minúsculas (CHECK en la base): `staff.login`, `staff.created`... */
  action: string;
  targetType?: string;
  targetId?: string;
  tenantId?: string;
  detail?: Prisma.InputJsonObject;
  ip?: string;
}

type AuditDb = Pick<BackofficePrismaService['client'], 'platformAuditLog'>;

/**
 * Auditoría del staff (append-only: el rol solo puede insertar y leer). Se escribe en la MISMA transacción que la
 * acción cuando la acción cambia datos, para que no exista una sin la otra.
 */
@Injectable()
export class PlatformAuditService {
  constructor(private readonly db: BackofficePrismaService) {}

  async record(entry: AuditEntry, tx: AuditDb = this.db.client): Promise<void> {
    await tx.platformAuditLog.create({
      data: {
        platformUserId: entry.platformUserId,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        tenantId: entry.tenantId ?? null,
        detail: entry.detail ?? {},
        ip: entry.ip ?? null,
      },
    });
  }
}
