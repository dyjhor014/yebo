import { Injectable } from '@nestjs/common';
import type { Member, MembershipStatus } from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import type { Principal, RequestContextStore } from '../../infrastructure/context/request-context';
import { declareChangeActor } from '../../infrastructure/database/change-actor';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { SessionService } from '../identity/session.service';
import { UserDirectoryService } from '../identity/user-directory.service';
import { PermissionService } from './permission.service';

const UUID = z.uuid();
const NOT_FOUND = () => new AppError('NOT_FOUND', 'Recurso no encontrado', 404);

/**
 * Gestión de accesos de la empresa del host (Fase 3.3; identity-and-sessions §8; multitenancy §1.1).
 * - Todo se lee y escribe con `yebo_app` dentro del tenant del contexto: un id de otra empresa no existe (404,
 *   multitenancy §7.1), por RLS y por el filtro de aplicación.
 * - `tenant_memberships`: `yebo_app` solo puede cambiar `status`, `permissions_version` y `updated_at`
 *   (privilegio por columna, migración 20261110120000).
 * - Las sesiones se cierran con SessionService (`yebo_identity`), solo las de ESTA empresa.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly db: TenantDbService,
    private readonly sessions: SessionService,
    private readonly directory: UserDirectoryService,
    private readonly permissions: PermissionService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  async list(): Promise<Member[]> {
    const rows = await this.db.client.tenantMembership.findMany({
      select: {
        id: true,
        userId: true,
        displayName: true,
        status: true,
        roles: { select: { roleId: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const people = await this.directory.describe(rows.map((r) => r.userId));
    return rows.map((r) => ({
      membershipId: r.id,
      email: people.get(r.userId)?.email ?? '',
      fullName: people.get(r.userId)?.fullName ?? '',
      displayName: r.displayName,
      status: r.status,
      roleIds: r.roles.map((x) => x.roleId).sort(),
    }));
  }

  /**
   * Suspende una membresía ACTIVE y cierra sus sesiones en esta empresa. El cambio de estado basta para cortar el
   * acceso (la verificación de cada request exige membresía ACTIVE); el cierre de sesiones evita que una
   * reactivación posterior las reviva (y la reactivación vuelve a cerrar las que quedaran).
   */
  async suspend(membershipId: string): Promise<{ status: MembershipStatus; revokedSessions: number }> {
    this.assertNotSelf(membershipId, 'No puedes suspender tu propio acceso');
    await this.transition(membershipId, 'ACTIVE', 'SUSPENDED');
    const revokedSessions = await this.sessions.revokeMembershipSessions(membershipId, 'MEMBERSHIP_REVOKED');
    return { status: 'SUSPENDED', revokedSessions };
  }

  /**
   * Reactiva una membresía SUSPENDED. En UNA transacción de tenant (regla de multitenancy §4.2, adoptada el
   * 2026-11-10): bloquea la membresía, comprueba el estado, cierra cualquier sesión que quedara de antes de la
   * suspensión y la reactiva. Si no está suspendida, responde 409 sin tocar sus sesiones.
   */
  async reactivate(membershipId: string): Promise<{ status: MembershipStatus; revokedSessions: number }> {
    this.assertNotSelf(membershipId, 'No puedes reactivar tu propio acceso');
    return this.transition(membershipId, 'SUSPENDED', 'ACTIVE', () =>
      this.sessions.revokeMembershipSessions(membershipId, 'ADMIN_REVOKED'),
    );
  }

  /** "Cerrar las sesiones del usuario" en ESTA empresa (identity-and-sessions §8). No afecta a otras empresas. */
  async revokeSessions(membershipId: string): Promise<number> {
    await this.requireMembership(membershipId);
    return this.sessions.revokeMembershipSessions(membershipId, 'ADMIN_REVOKED');
  }

  /**
   * Reemplaza los roles de una membresía e incrementa su `permissions_version` en la MISMA transacción: los tokens
   * emitidos antes reciben `401 PERMISSIONS_CHANGED` y se renuevan con los permisos nuevos.
   * Contra la escalada de privilegios, quien asigna debe tener TODOS los permisos de los roles que asigna y de los
   * que retira (no puede conceder lo que no tiene ni degradar a alguien con más permisos), y no puede cambiar los
   * suyos.
   */
  async assignRoles(membershipId: string, roleIds: readonly string[]): Promise<string[]> {
    this.assertNotSelf(membershipId, 'No puedes cambiar tus propios roles');
    if (!UUID.safeParse(membershipId).success) throw NOT_FOUND();
    const own = await this.permissions.current();
    const tenantId = this.tenantId();
    return this.db.transaction(async (tx) => {
      // Bloquea la membresía: dos asignaciones simultáneas se serializan (RLS: solo filas de este tenant).
      const [target] = await tx.$queryRaw<{ status: MembershipStatus }[]>`
        SELECT status::text AS status FROM tenant_memberships WHERE id = ${membershipId}::uuid FOR UPDATE`;
      if (!target) throw NOT_FOUND();
      if (target.status === 'REVOKED') {
        throw new AppError('CONFLICT', 'La membresía está revocada; no se le pueden asignar roles', 409);
      }
      const wanted = await tx.role.findMany({
        where: { id: { in: [...roleIds] }, archivedAt: null },
        select: { id: true, permissions: { select: { permission: { select: { code: true } } } } },
      });
      if (wanted.length !== roleIds.length) throw NOT_FOUND();
      const current = await tx.membershipRole.findMany({
        where: { membershipId },
        select: { role: { select: { permissions: { select: { permission: { select: { code: true } } } } } } },
      });
      const touched = [...wanted, ...current.map((c) => c.role)].flatMap((r) =>
        r.permissions.map((p) => p.permission.code),
      );
      if (touched.some((code) => !own.has(code))) {
        throw new AppError(
          'FORBIDDEN',
          'No puedes asignar ni retirar roles con permisos que tú no tienes',
          403,
        );
      }
      await tx.membershipRole.deleteMany({ where: { membershipId } });
      if (roleIds.length > 0) {
        await tx.membershipRole.createMany({
          data: roleIds.map((roleId) => ({ tenantId, membershipId, roleId })),
        });
      }
      await tx.tenantMembership.updateMany({
        where: { id: membershipId },
        data: { permissionsVersion: { increment: 1 } },
      });
      return [...roleIds].sort();
    });
  }

  /**
   * Cambia el estado con la membresía bloqueada (`FOR UPDATE`). `beforeUpdate` se ejecuta con el bloqueo tomado y
   * el estado ya comprobado (p. ej., cerrar sesiones con yebo_identity, que no toca tenant_memberships).
   */
  private async transition(
    membershipId: string,
    from: MembershipStatus,
    to: MembershipStatus,
    beforeUpdate: () => Promise<number> = async () => 0,
  ): Promise<{ status: MembershipStatus; revokedSessions: number }> {
    if (!UUID.safeParse(membershipId).success) throw NOT_FOUND();
    return this.db.transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ status: MembershipStatus }[]>`
        SELECT status::text AS status FROM tenant_memberships WHERE id = ${membershipId}::uuid FOR UPDATE`;
      if (!row) throw NOT_FOUND();
      if (row.status !== from) {
        throw new AppError('CONFLICT', `La membresía no está en el estado requerido (${from})`, 409);
      }
      const revokedSessions = await beforeUpdate();
      // Autor del cambio para el historial de medición (lo copian los triggers).
      const support = this.cls.get('supportPrincipal');
      await declareChangeActor(tx, {
        // Fase 4.6: el staff de soporte queda como autor con su id de plataforma.
        kind: support ? 'PLATFORM_USER' : 'MEMBERSHIP',
        id: support ? support.platformUserId : this.principal().membershipId,
        reason: to === 'SUSPENDED' ? 'members.suspend' : 'members.reactivate',
      });
      await tx.tenantMembership.updateMany({ where: { id: membershipId }, data: { status: to } });
      return { status: to, revokedSessions };
    });
  }

  private async requireMembership(membershipId: string): Promise<void> {
    if (!UUID.safeParse(membershipId).success) throw NOT_FOUND();
    const found = await this.db.client.tenantMembership.findFirst({
      where: { id: membershipId },
      select: { id: true },
    });
    if (!found) throw NOT_FOUND();
  }

  private assertNotSelf(membershipId: string, message: string): void {
    if (this.cls.get('supportPrincipal')) return; // el staff no tiene membresía propia
    if (membershipId === this.principal().membershipId) throw new AppError('FORBIDDEN', message, 403);
  }

  /** Del contexto (host), nunca del cliente. La extensión de tenant rechaza cualquier otro valor. */
  private tenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new Error('MembersService requiere el tenant del contexto');
    return tenantId;
  }

  private principal(): Principal {
    const principal = this.cls.get('principal');
    if (!principal) throw new Error('MembersService requiere una sesión verificada');
    return principal;
  }
}
