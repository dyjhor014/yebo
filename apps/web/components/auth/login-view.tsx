'use client';

import type { FormEvent } from 'react';
import { AccessShell } from '@yebo/ui/access-shell';
import { Button } from '@yebo/ui/button';
import { PasswordField, TextField } from '@yebo/ui/field';
import { Notice } from '@yebo/ui/notice';
import { AccessHeading } from './heading';

export interface LoginFieldErrors {
  email?: string | null;
  password?: string | null;
}

export interface LoginViewProps {
  /** Empresa a la que se quiere entrar, si se llegó desde su dominio. */
  destination: string | null;
  submitting: boolean;
  /** Error general (credenciales, demasiados intentos, servicio ocupado, sin conexión). */
  error: string | null;
  fieldErrors: LoginFieldErrors;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

/** Login central de YEBO (el único lugar donde se escriben credenciales). */
export function LoginView({ destination, submitting, error, fieldErrors, onSubmit }: LoginViewProps) {
  return (
    <AccessShell destination={destination}>
      <AccessHeading title="Inicia sesión">
        {destination
          ? `Usa tu cuenta YEBO para entrar a ${destination}.`
          : 'Usa tu cuenta YEBO para entrar a tus empresas.'}
      </AccessHeading>
      <form className="mt-8 flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        {error && <Notice>{error}</Notice>}
        <TextField
          label="Correo electrónico"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={254}
          error={fieldErrors.email}
        />
        <PasswordField
          label="Contraseña"
          name="password"
          autoComplete="current-password"
          maxLength={1024}
          error={fieldErrors.password}
        />
        <div className="pt-1">
          <Button type="submit" busy={submitting} busyLabel="Entrando…">
            Entrar
          </Button>
        </div>
      </form>
    </AccessShell>
  );
}
