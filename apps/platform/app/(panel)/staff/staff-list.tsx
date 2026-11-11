'use client';

import {
  DisablePlatformStaffResponseSchema,
  PlatformSetupLinkResponseSchema,
  PlatformStaffListResponseSchema,
  type PlatformStaffMember,
} from '@yebo/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '@/components/dialog';
import { OneTimeLink } from '@/components/one-time-link';
import { can, useSession } from '@/components/session';
import { Pill } from '@/components/status-pill';
import { Alert, PRIMARY, SECONDARY } from '@/components/ui';
import { ApiError, get, post } from '@/lib/api';
import { InviteStaff, ROLE_INFO } from './invite-staff';

/** «Staff de YEBO»: miembros, su estado de acceso y las acciones de gestión (platform.staff.manage). */
export function StaffList() {
  const session = useSession();
  const manage = can(session, 'platform.staff.manage');
  const [staff, setStaff] = useState<PlatformStaffMember[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const [disabling, setDisabling] = useState<PlatformStaffMember | null>(null);
  const [closeSignal, setCloseSignal] = useState(0);
  const fmt = new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Lima',
  });

  const load = useCallback(() => {
    get('/api/v1/platform/staff', PlatformStaffListResponseSchema)
      .then((r) => setStaff(r.staff))
      .catch((e: Error) => setFailure(e.message));
  }, []);
  useEffect(() => {
    if (manage) load();
  }, [load, manage]);

  async function newLink(m: PlatformStaffMember) {
    setFailure(null);
    try {
      const r = await post(
        `/api/v1/platform/staff/${m.platformUserId}/setup-link`,
        undefined,
        PlatformSetupLinkResponseSchema,
      );
      setLink({ name: m.fullName, url: r.setupUrl });
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo generar el enlace.');
    }
  }

  async function disable(m: PlatformStaffMember) {
    setFailure(null);
    try {
      await post(
        `/api/v1/platform/staff/${m.platformUserId}/disable`,
        undefined,
        DisablePlatformStaffResponseSchema,
      );
      setDisabling(null);
      load();
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo desactivar.');
      setDisabling(null);
    }
  }

  if (!manage) {
    return (
      <>
        <h1 className="font-display text-[1.875rem] font-extrabold tracking-[-0.02em]">Staff de YEBO</h1>
        <p className="text-ink-muted">Solo un superadmin gestiona el staff.</p>
      </>
    );
  }

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-[1.875rem] font-extrabold tracking-[-0.02em]">Staff de YEBO</h1>
          <p className="text-[0.9375rem] text-ink-muted">Quién entra al panel y con qué rol.</p>
        </div>
        <button type="button" onClick={() => setInviting(true)} className={PRIMARY}>
          Invitar al staff
        </button>
      </header>
      {failure && <Alert>{failure}</Alert>}
      <section aria-label="Miembros del staff" className="rounded-xl border border-divider bg-raised">
        {staff === null && !failure && <p className="px-5 py-6 text-ink-muted">Cargando…</p>}
        <ul>
          {staff?.map((m) => {
            const me = m.platformUserId === session.platformUserId;
            return (
              <li
                key={m.platformUserId}
                className="flex flex-wrap items-center justify-between gap-3 border-t border-divider px-5 py-4 first:border-t-0"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">
                    {m.fullName}
                    {me && <span className="font-normal text-ink-muted"> (tú)</span>}
                  </span>
                  <span className="text-sm text-ink-muted">
                    {m.email} · {ROLE_INFO[m.role].label} ·{' '}
                    {!m.setupCompleted
                      ? 'sin configurar la contraseña'
                      : !m.mfaEnabled
                        ? 'sin verificación en dos pasos'
                        : m.lastLoginAt
                          ? `último acceso ${fmt.format(new Date(m.lastLoginAt))}`
                          : 'aún no ha entrado'}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-3">
                  {m.status === 'DISABLED' ? (
                    <Pill tone="neutral">Desactivado</Pill>
                  ) : (
                    !me && (
                      <>
                        <button type="button" onClick={() => newLink(m)} className={SECONDARY}>
                          {m.setupCompleted ? 'Restablecer acceso' : 'Nuevo enlace de configuración'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDisabling(m)}
                          className="min-h-11 px-2 font-semibold text-danger underline underline-offset-4"
                        >
                          Desactivar
                        </button>
                      </>
                    )
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {inviting && <InviteStaff onClose={() => setInviting(false)} onCreated={load} />}
      {link && (
        <Dialog
          title="Enlace de configuración"
          description={`${link.name}: invalida los enlaces anteriores sin usar.`}
          onRequestClose={() => setCloseSignal((n) => n + 1)}
        >
          <OneTimeLink
            label="Enlace de un solo uso"
            link={link.url}
            onDone={() => setLink(null)}
            closeSignal={closeSignal}
          />
        </Dialog>
      )}
      {disabling && (
        <Dialog
          title={`¿Desactivar a ${disabling.fullName}?`}
          description="Se cierran sus sesiones al momento y ya no podrá entrar al panel."
          onRequestClose={() => setDisabling(null)}
        >
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={() => setDisabling(null)} className={SECONDARY}>
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => disable(disabling)}
              className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-danger px-5 font-semibold text-canvas"
            >
              Desactivar
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
