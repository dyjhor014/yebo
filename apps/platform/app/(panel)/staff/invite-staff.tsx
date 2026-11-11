'use client';

import {
  PlatformInvitationResponseSchema,
  type PlatformInvitationResponse,
  type PlatformRole,
} from '@yebo/contracts';
import { useState } from 'react';
import { Dialog } from '@/components/dialog';
import { OneTimeLink } from '@/components/one-time-link';
import { Alert, Input, PRIMARY, SECONDARY, Success } from '@/components/ui';
import { ApiError, post } from '@/lib/api';

/** Dominio del staff. La API lo impone (PLATFORM_STAFF_EMAIL_DOMAIN); aquí solo se avisa antes. */
const STAFF_DOMAIN = 'yebo.pe';

export const ROLE_INFO: Record<PlatformRole, { label: string; text: string }> = {
  SUPPORT: { label: 'Soporte', text: 'Abre accesos de soporte temporales a las empresas, que ellas ven.' },
  BILLING: { label: 'Cobros', text: 'Planes, cambios de plan, facturas y registro de pagos.' },
  VIEWER: { label: 'Solo lectura', text: 'Consulta empresas, consumo y cobros; no cambia nada.' },
  SUPERADMIN: {
    label: 'Superadmin',
    text: 'Todo lo anterior y además: dar de alta y suspender empresas, gestionar el staff (incluidos otros superadmins).',
  },
};

/** «Invitar al staff de YEBO» (maqueta v2, pantalla 4): solo @yebo.pe; Superadmin separado y con confirmación. */
export function InviteStaff({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PlatformRole>('SUPPORT');
  const [confirmed, setConfirmed] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState<PlatformInvitationResponse | null>(null);
  const [closeSignal, setCloseSignal] = useState(0);

  const emailOk = new RegExp(`^[^\\s@]+@${STAFF_DOMAIN.replace('.', '\\.')}$`, 'i').test(email.trim());
  const emailError =
    (tried || email.includes('@')) && !emailOk ? `El staff solo admite correos @${STAFF_DOMAIN}.` : null;
  const nameError = tried && !fullName.trim() ? 'Escribe el nombre completo.' : null;
  const superError =
    tried && role === 'SUPERADMIN' && !confirmed ? 'Confirma el acceso total o elige otro rol.' : null;

  async function send() {
    setTried(true);
    if (!emailOk || !fullName.trim() || (role === 'SUPERADMIN' && !confirmed)) return;
    setBusy(true);
    setFailure(null);
    try {
      setSent(
        await post(
          '/api/v1/platform/invitations',
          { target: 'STAFF', email: email.trim(), fullName: fullName.trim(), role },
          PlatformInvitationResponseSchema,
        ),
      );
      onCreated();
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo crear la invitación.');
    } finally {
      setBusy(false);
    }
  }

  const radio = (r: PlatformRole, danger = false) => (
    <label
      key={r}
      className={`flex items-start gap-2.5 rounded-[var(--radius-control)] border px-3 py-2.5 ${danger ? 'border-danger' : 'border-divider'}`}
    >
      <input
        type="radio"
        name="rol"
        checked={role === r}
        onChange={() => {
          setRole(r);
          setConfirmed(false);
        }}
        className="mt-0.5 size-[1.125rem]"
      />
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold">{ROLE_INFO[r].label}</span>
        <span className="text-[0.8125rem] text-ink-muted">{ROLE_INFO[r].text}</span>
      </span>
    </label>
  );

  return (
    <Dialog
      title="Invitar al staff de YEBO"
      description="Entrará en el panel con contraseña y verificación en dos pasos."
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
            label="Nombre completo"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            maxLength={200}
            error={nameError}
          />
          <Input
            label="Correo de YEBO"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailError}
            hint={`Solo correos @${STAFF_DOMAIN}.`}
          />
          <fieldset className="flex flex-col gap-2.5">
            <legend className="mb-1.5 text-sm font-medium">Rol de plataforma</legend>
            {(['SUPPORT', 'BILLING', 'VIEWER'] as const).map((r) => radio(r))}
            <div className="mt-1.5 flex flex-col gap-2 border-t border-divider pt-3">
              <span className="text-[0.8125rem] font-semibold text-danger">Acceso total</span>
              {radio('SUPERADMIN', true)}
              {role === 'SUPERADMIN' && (
                <>
                  <label className="flex items-start gap-2.5 rounded-[var(--radius-control)] bg-danger-surface px-3 py-3 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={() => setConfirmed((c) => !c)}
                      aria-describedby={superError ? 'super-error' : undefined}
                      className="mt-0.5 size-[1.125rem]"
                    />
                    <span>
                      Confirmo que esta persona necesita <strong>acceso total</strong> a todas las empresas,
                      los cobros y el staff.
                    </span>
                  </label>
                  {superError && (
                    <span id="super-error" className="text-[0.8125rem] font-semibold text-danger">
                      {superError}
                    </span>
                  )}
                </>
              )}
            </div>
          </fieldset>
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={onClose} className={SECONDARY}>
              Cancelar
            </button>
            <button type="submit" disabled={busy} aria-busy={busy || undefined} className={PRIMARY}>
              {busy ? 'Creando invitación…' : 'Crear invitación'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <Success>
            {fullName.trim()} (<strong>{sent.email}</strong>) entra al staff como{' '}
            <strong>{ROLE_INFO[role].label}</strong>
            {role === 'SUPERADMIN' ? ' (acceso total)' : ''}. El enlace caduca el{' '}
            {new Intl.DateTimeFormat('es-PE', {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: 'America/Lima',
            }).format(new Date(sent.expiresAt))}
            .
          </Success>
          <OneTimeLink
            label="Enlace de configuración de un solo uso"
            link={sent.link}
            onDone={onClose}
            closeSignal={closeSignal}
          />
        </>
      )}
    </Dialog>
  );
}
