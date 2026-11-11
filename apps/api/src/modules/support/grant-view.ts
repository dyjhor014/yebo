import type { SupportGrant } from '@yebo/contracts';
import type { Prisma } from '../../generated/prisma/client';

/**
 * Lectura de los accesos de soporte de UN tenant con su registro, dentro de una transacción con su contexto (RLS).
 * La comparten el panel (`yebo_backoffice`) y la empresa (`yebo_app`).
 */
type Tx = Pick<Prisma.TransactionClient, 'supportAccessGrant'>;

export async function readSupportGrants(tx: Tx, now: Date): Promise<SupportGrant[]> {
  const rows = await tx.supportAccessGrant.findMany({
    include: { logs: { orderBy: { occurredAt: 'desc' }, take: 500 } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((g) => ({
    id: g.id,
    staffName: g.staffName,
    staffEmail: g.staffEmail,
    reason: g.reason,
    scope: g.scope,
    status: g.revokedAt
      ? 'REVOKED'
      : g.expiresAt <= now
        ? 'EXPIRED'
        : g.requiresApproval && !g.approvedAt
          ? 'PENDING_APPROVAL'
          : 'ACTIVE',
    startsAt: g.startsAt.toISOString(),
    expiresAt: g.expiresAt.toISOString(),
    requiresApproval: g.requiresApproval,
    approvedAt: g.approvedAt?.toISOString() ?? null,
    revokedAt: g.revokedAt?.toISOString() ?? null,
    revokedBy:
      g.revokedByKind === 'PLATFORM_USER' || g.revokedByKind === 'MEMBERSHIP' ? g.revokedByKind : null,
    accesses: g.logs.map((l) => ({
      occurredAt: l.occurredAt.toISOString(),
      method: l.method,
      route: l.route,
    })),
  }));
}
