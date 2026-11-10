'use client';

import {
  PlatformLoginResponseSchema,
  PlatformMfaEnrollResponseSchema,
  type PlatformMfaEnrollResponse,
} from '@yebo/contracts';
import { Button } from '@yebo/ui/button';
import { PasswordField, TextField } from '@yebo/ui/field';
import { Logo } from '@yebo/ui/logo';
import { Notice } from '@yebo/ui/notice';
import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, post } from '@/lib/api';

type Step = 'password' | 'verify' | 'enroll';

/** Solo rutas internas del panel: nunca una URL absoluta ni `//host` (redirección abierta). */
function safeReturn(raw: string | null): string {
  return raw && /^\/(?!\/)[\w\-/%]*$/.test(raw) ? raw : '/empresas';
}

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.';
    if (e.status === 503) return 'El servicio está ocupado. Inténtalo de nuevo en unos segundos.';
    return e.message;
  }
  return 'Sin conexión con el servidor. Revisa tu red e inténtalo de nuevo.';
}

/**
 * Acceso del staff (admin.yebo.pe, Fase 4.1): contraseña y SIEMPRE segundo factor. Si la MFA aún no está activa,
 * se activa aquí mismo con la app de autenticación. Realm propio: no son las Cuentas YEBO de las empresas.
 */
export function StaffLogin() {
  const params = useSearchParams();
  const [step, setStep] = useState<Step>('password');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<PlatformMfaEnrollResponse | null>(null);

  async function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (!email || !password) {
      setError('Escribe tu correo de YEBO y tu contraseña.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await post('/api/v1/platform/auth/login', { email, password }, PlatformLoginResponseSchema);
      if (res.next === 'MFA_ENROLL') {
        setEnroll(await post('/api/v1/platform/auth/mfa/enroll', undefined, PlatformMfaEnrollResponseSchema));
        setStep('enroll');
      } else setStep('verify');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) {
      setFieldError('El código tiene 6 dígitos.');
      return;
    }
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      await post(`/api/v1/platform/auth/mfa/${step === 'enroll' ? 'activate' : 'verify'}`, { code });
      window.location.assign(safeReturn(params.get('volver')));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && err.message.toLowerCase().includes('caduc')) {
        setStep('password');
        setEnroll(null);
      }
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink lg:grid lg:grid-cols-[minmax(20rem,26rem)_1fr]">
      <aside className="yebo-rail flex flex-col gap-2 bg-rail px-5 py-5 text-on-rail sm:px-8 lg:min-h-dvh lg:justify-between lg:p-12">
        <div className="flex flex-col gap-2">
          <Logo className="text-2xl lg:text-[1.75rem]" />
          <span className="text-sm font-semibold text-on-rail-muted">
            Panel de plataforma · solo staff de YEBO
          </span>
        </div>
      </aside>
      <main className="px-5 pt-10 pb-16 sm:px-8 lg:flex lg:items-center lg:px-16">
        <div className="mx-auto flex w-full max-w-[24rem] flex-col gap-8 lg:mx-0">
          {step === 'password' && (
            <>
              <Heading title="Inicia sesión">
                Con tu correo de YEBO. Después te pediremos el código de tu app de autenticación.
              </Heading>
              <form className="flex flex-col gap-5" onSubmit={onPassword} noValidate>
                {error && <Notice>{error}</Notice>}
                <TextField
                  label="Correo de YEBO"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  required
                />
                <PasswordField label="Contraseña" name="password" autoComplete="current-password" required />
                <Button type="submit" busy={busy} busyLabel="Comprobando…">
                  Continuar
                </Button>
              </form>
            </>
          )}
          {step !== 'password' && (
            <>
              <Heading
                title={
                  step === 'enroll' ? 'Activa la verificación en dos pasos' : 'Verificación en dos pasos'
                }
              >
                {step === 'enroll'
                  ? 'Es obligatoria para el staff. Necesitas una app de autenticación en el móvil (Google Authenticator, Microsoft Authenticator o similar).'
                  : 'Escribe el código de 6 dígitos de tu app de autenticación.'}
              </Heading>
              {step === 'enroll' && enroll && (
                <ol className="flex list-decimal flex-col gap-3 pl-5 text-[0.9375rem]">
                  <li>
                    En la app, pulsa <strong>+</strong> y elige{' '}
                    <strong>«Introducir una clave de configuración»</strong> (o «Introducir clave
                    manualmente»).
                  </li>
                  <li className="flex flex-col gap-2">
                    <span>
                      Nombre de la cuenta: <strong>YEBO Admin</strong>. Clave (tipo «basada en tiempo»):
                    </span>
                    <code className="rounded-[var(--radius-control)] bg-ink/5 px-3 py-2 font-mono text-base tracking-wider break-all select-all">
                      {enroll.secret.replace(/(.{4})/g, '$1 ').trim()}
                    </code>
                    <span className="text-sm text-ink-muted">
                      Esta clave NO se escribe aquí: va en la app. Se muestra una sola vez; no la compartas.
                    </span>
                  </li>
                  <li>Escribe abajo el código de 6 dígitos que genera la app (cambia cada 30 segundos).</li>
                </ol>
              )}
              <form className="flex flex-col gap-5" onSubmit={onCode} noValidate>
                {error && <Notice>{error}</Notice>}
                <TextField
                  // Aparece tras enviar la contraseña: el foco va directo al código.
                  autoFocus
                  label={step === 'enroll' ? 'Código de 6 dígitos que muestra la app' : 'Código de 6 dígitos'}
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={7}
                  error={fieldError}
                  required
                />
                <Button type="submit" busy={busy} busyLabel="Verificando…">
                  {step === 'enroll' ? 'Activar y entrar' : 'Entrar'}
                </Button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="font-display text-[1.75rem] font-extrabold tracking-[-0.02em] text-balance">{title}</h1>
      <p className="text-[0.9375rem] text-ink-muted text-pretty">{children}</p>
    </div>
  );
}
