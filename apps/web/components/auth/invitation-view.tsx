'use client';

import type { FormEvent } from 'react';
import { AccessShell } from '../identity/access-shell';
import { Button, ButtonLink } from '../ui/button';
import { PasswordField, TextField } from '../ui/field';
import { Notice } from '../ui/notice';
import { TextLink } from '../ui/text-link';
import { AccessHeading } from './heading';

export type InvitationMode = 'register' | 'login';

export type InvitationState =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'error' }
  | {
      kind: 'ready';
      company: string;
      email: string;
      /** Hay sesión del hub en este navegador: basta con aceptar. */
      signedIn: boolean;
      mode: InvitationMode;
    }
  | { kind: 'accepted'; company: string; host: string };

export interface InvitationFieldErrors {
  fullName?: string | null;
  password?: string | null;
  confirm?: string | null;
}

export interface InvitationViewProps {
  state: InvitationState;
  submitting: boolean;
  error: string | null;
  fieldErrors: InvitationFieldErrors;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onModeChange: (mode: InvitationMode) => void;
}

/**
 * Aceptar una invitación en el hub (Fase 4.3b). La persona ve a qué empresa la invitan y con qué correo; acepta con
 * su sesión, inicia sesión o crea su cuenta. La pantalla es la misma exista o no una cuenta con ese correo.
 */
export function InvitationView({
  state,
  submitting,
  error,
  fieldErrors,
  onSubmit,
  onModeChange,
}: InvitationViewProps) {
  if (state.kind === 'loading') {
    return (
      <AccessShell>
        <AccessHeading title="Revisando tu invitación…" />
      </AccessShell>
    );
  }
  if (state.kind === 'invalid' || state.kind === 'error') {
    return (
      <AccessShell route="blocked">
        <AccessHeading
          title={state.kind === 'invalid' ? 'Esta invitación ya no sirve' : 'No pudimos abrir la invitación'}
        >
          {state.kind === 'invalid'
            ? 'El enlace no es válido, caducó o ya se usó. Pide a quien te invitó que te envíe uno nuevo.'
            : 'Revisa tu conexión y vuelve a abrir el enlace.'}
        </AccessHeading>
      </AccessShell>
    );
  }
  if (state.kind === 'accepted') {
    return (
      <AccessShell destination={state.company} route="travelling">
        <AccessHeading title={`Ya formas parte de ${state.company}`}>
          Tu acceso está listo. Entra cuando quieras con tu cuenta YEBO.
        </AccessHeading>
        <div className="mt-8">
          <ButtonLink href={`https://${state.host}/panel`}>Entrar a {state.company}</ButtonLink>
        </div>
      </AccessShell>
    );
  }

  const { company, email, signedIn, mode } = state;
  return (
    <AccessShell destination={company}>
      <AccessHeading title={`Te invitaron a ${company}`}>
        La invitación es para <strong className="font-semibold text-ink">{email}</strong>.
      </AccessHeading>
      <form className="mt-8 flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        {error && <Notice>{error}</Notice>}
        {signedIn ? (
          <p className="text-base leading-6 text-ink-muted">
            Ya iniciaste sesión en este navegador. Si no es la cuenta de {email},{' '}
            <TextLink href="/salir">cierra la sesión</TextLink> y vuelve a abrir el enlace.
          </p>
        ) : mode === 'register' ? (
          <>
            <TextField
              label="Tu nombre completo"
              name="fullName"
              autoComplete="name"
              maxLength={120}
              error={fieldErrors.fullName}
            />
            <PasswordField
              label="Crea una contraseña"
              name="password"
              autoComplete="new-password"
              maxLength={128}
              error={fieldErrors.password}
            />
            <p className="-mt-3 text-sm text-ink-muted">
              Al menos 10 caracteres. Una frase fácil de recordar funciona bien.
            </p>
            <PasswordField
              label="Repite la contraseña"
              name="confirm"
              autoComplete="new-password"
              maxLength={128}
              error={fieldErrors.confirm}
            />
          </>
        ) : (
          <>
            <input type="email" name="email" value={email} autoComplete="username" readOnly hidden />
            <PasswordField
              label="Tu contraseña de YEBO"
              name="password"
              autoComplete="current-password"
              maxLength={1024}
              error={fieldErrors.password}
            />
          </>
        )}
        <div className="flex flex-col gap-3 pt-1">
          <Button type="submit" busy={submitting} busyLabel="Aceptando…">
            {signedIn
              ? 'Aceptar la invitación'
              : mode === 'register'
                ? 'Crear mi cuenta y aceptar'
                : 'Entrar y aceptar'}
          </Button>
          {!signedIn && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => onModeChange(mode === 'register' ? 'login' : 'register')}
            >
              {mode === 'register' ? 'Ya tengo una cuenta YEBO' : 'No tengo cuenta: crearla'}
            </Button>
          )}
        </div>
      </form>
    </AccessShell>
  );
}
