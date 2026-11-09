/**
 * Autor de un cambio de membresía o de usuario (Fase 4.4; decisión del 2026-11-10). Se declara en la TRANSACCIÓN que
 * hace el cambio, antes de hacerlo, y los triggers de `membership_status_history` lo copian a cada fila. Un rol de
 * ejecución que cambie una membresía sin declararlo recibe un error de la base: nunca queda un cambio sin autor.
 */
export type ChangeActorKind = 'MEMBERSHIP' | 'USER' | 'PLATFORM_USER';

export interface ChangeActor {
  kind: ChangeActorKind;
  /** Membresía, usuario o miembro del staff que hace el cambio. */
  id: string;
  /** Código breve de la operación (`members.suspend`, `invitation.accepted`...). */
  reason: string;
}

interface RawExecutor {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export async function declareChangeActor(tx: RawExecutor, actor: ChangeActor): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.actor_kind', ${actor.kind}, true),
                              set_config('app.actor_id', ${actor.id}, true),
                              set_config('app.change_reason', ${actor.reason}, true)`;
}
