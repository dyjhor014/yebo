'use client';

import { HubAuthorizeQuerySchema, HubBrandingResponseSchema } from '@yebo/contracts';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { LoginView, type LoginFieldErrors } from '@/components/auth/login-view';
import { AuthRequestError, apiFetch, fetchCsrf } from '@/lib/auth-client';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mensajes para el usuario: qué pasó y cómo seguir; nunca códigos ni detalles del protocolo. */
function messageFor(error: unknown): string {
  if (error instanceof AuthRequestError) {
    if (error.status === 401)
      return 'El correo o la contraseña no son correctos. Revísalos e inténtalo de nuevo.';
    if (error.status === 429)
      return 'Hiciste demasiados intentos. Espera unos minutos antes de volver a intentarlo.';
    if (error.status === 503)
      return 'El servicio está ocupado en este momento. Inténtalo de nuevo en unos segundos.';
    return 'No pudimos iniciar tu sesión. Inténtalo de nuevo.';
  }
  return 'No pudimos conectar. Revisa tu conexión e inténtalo de nuevo.';
}

/**
 * Lógica del login del hub (identity-and-sessions §3). Si se llegó desde una empresa, al iniciar sesión vuelve a
 * la autorización con los mismos parámetros para completar el acceso; si no, muestra las empresas del usuario.
 */
export function LoginForm() {
  const params = useSearchParams();
  const authorize = HubAuthorizeQuerySchema.safeParse(Object.fromEntries(params.entries()));
  const tenantHost = authorize.success ? authorize.data.tenant_host : null;
  const [destination, setDestination] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});

  useEffect(() => {
    if (!tenantHost) return;
    apiFetch(`/api/v1/hub/branding?tenant_host=${encodeURIComponent(tenantHost)}`)
      .then(async (res) => {
        const parsed = HubBrandingResponseSchema.safeParse(await res.json());
        if (parsed.success) setDestination(parsed.data.tradeName);
      })
      .catch(() => setDestination(null));
  }, [tenantHost]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const errors: LoginFieldErrors = {
      email: !email
        ? 'Escribe tu correo.'
        : EMAIL.test(email)
          ? null
          : 'Escribe un correo válido, por ejemplo nombre@empresa.pe.',
      password: password ? null : 'Escribe tu contraseña.',
    };
    setFieldErrors(errors);
    setError(null);
    if (errors.email || errors.password) {
      const field = event.currentTarget.elements.namedItem(errors.email ? 'email' : 'password');
      if (field instanceof HTMLInputElement) field.focus();
      return;
    }
    setSubmitting(true);
    try {
      const csrf = await fetchCsrf('/api/v1/hub/csrf');
      await apiFetch('/api/v1/hub/login', {
        method: 'POST',
        csrf,
        body: JSON.stringify({ email, password }),
      });
      window.location.assign(
        authorize.success ? `/api/v1/hub/authorize?${new URLSearchParams(authorize.data)}` : '/sin-acceso',
      );
    } catch (e) {
      setSubmitting(false);
      setError(messageFor(e));
    }
  }

  return (
    <LoginView
      destination={destination}
      submitting={submitting}
      error={error}
      fieldErrors={fieldErrors}
      onSubmit={onSubmit}
    />
  );
}
