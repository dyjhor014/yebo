'use client';

import {
  PlatformInvitationResponseSchema,
  PlatformTenantRolesResponseSchema,
  type PlatformInvitationResponse,
  type PlatformTenantRolesResponse,
} from '@yebo/contracts';
import { useEffect, useState } from 'react';
import { Dialog } from '@/components/dialog';
import { OneTimeLink } from '@/components/one-time-link';
import { Alert, Input, PRIMARY, SECONDARY, Success } from '@/components/ui';
import { ApiError, get, post } from '@/lib/api';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** «Invitar a la empresa» (maqueta v2, pantalla 3): empresa fijada, sus roles, enlace de un solo uso. */
export function InviteToTenant({
  tenantId,
  tradeName,
  host,
  onClose,
}: {
  tenantId: string;
  tradeName: string;
  host: string | null;
  onClose: () => void;
}) {
  const [roles, setRoles] = useState<PlatformTenantRolesResponse['roles'] | null>(null);
  const [email, setEmail] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState<PlatformInvitationResponse | null>(null);
  const [closeSignal, setCloseSignal] = useState(0);

  useEffect(() => {
    get(`/api/v1/platform/tenants/${tenantId}/roles`, PlatformTenantRolesResponseSchema)
      .then((r) => setRoles(r.roles))
      .catch((e: Error) => setFailure(e.message));
  }, [tenantId]);

  const emailError = tried && !EMAIL.test(email.trim()) ? 'Escribe un correo válido.' : null;
  const rolesError = tried && picked.length === 0 ? 'Elige al menos un rol.' : null;
  const names = (roles ?? []).filter((r) => picked.includes(r.id)).map((r) => r.name);

  async function send() {
    setTried(true);
    if (!EMAIL.test(email.trim()) || picked.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      setSent(
        await post(
          '/api/v1/platform/invitations',
          { target: 'TENANT', tenantId, email: email.trim(), roleIds: picked },
          PlatformInvitationResponseSchema,
        ),
      );
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo crear la invitación.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Invitar a ${tradeName}`}
      description={`${host ? `${host} · ` : ''}el enlace se muestra una sola vez.`}
      onRequestClose={() => (sent ? setCloseSignal((n) => n + 1) : onClose())}
    >
      {!sent ? (
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {failure && <Alert>{failure}</Alert>}
          <Input
            label="Correo de la persona"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailError}
            hint="No hace falta que tenga cuenta en YEBO: la crea al aceptar."
          />
          <fieldset
            aria-describedby={rolesError ? 'roles-error' : undefined}
            className="flex flex-col gap-2.5"
          >
            <legend className="mb-1.5 text-sm font-medium">Roles en {tradeName}</legend>
            {roles === null && !failure && <p className="text-sm text-ink-muted">Cargando roles…</p>}
            {roles?.map((r) => (
              <label
                key={r.id}
                className="flex min-h-11 items-center gap-2.5 rounded-[var(--radius-control)] border border-divider px-3 py-2.5"
              >
                <input
                  type="checkbox"
                  checked={picked.includes(r.id)}
                  onChange={() =>
                    setPicked((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id]))
                  }
                  className="size-[1.125rem] accent-[var(--yebo-midnight-navy)]"
                />
                <span className="font-semibold">{r.name}</span>
                {r.isSystem && <span className="text-[0.8125rem] text-ink-muted">· del sistema</span>}
              </label>
            ))}
            {rolesError && (
              <span id="roles-error" className="text-[0.8125rem] font-semibold text-danger">
                {rolesError}
              </span>
            )}
          </fieldset>
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={onClose} className={SECONDARY}>
              Cancelar
            </button>
            <button
              type="submit"
              disabled={busy || roles === null}
              aria-busy={busy || undefined}
              className={PRIMARY}
            >
              {busy ? 'Creando invitación…' : 'Crear invitación'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <Success>
            Invitación para <strong>{sent.email}</strong> como <strong>{names.join(' y ')}</strong> de{' '}
            {tradeName}. Caduca el{' '}
            {new Intl.DateTimeFormat('es-PE', {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: 'America/Lima',
            }).format(new Date(sent.expiresAt))}
            .
          </Success>
          <OneTimeLink
            label="Enlace de un solo uso"
            link={sent.link}
            onDone={onClose}
            closeSignal={closeSignal}
            anotherLabel="Invitar a otra persona"
            onAnother={() => {
              setSent(null);
              setEmail('');
              setPicked([]);
              setTried(false);
            }}
          />
        </>
      )}
    </Dialog>
  );
}
