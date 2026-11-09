'use client';

import { HubInvitationAcceptedSchema, HubInvitationPreviewSchema } from '@yebo/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import {
  InvitationView,
  type InvitationFieldErrors,
  type InvitationMode,
  type InvitationState,
} from '@/components/auth/invitation-view';
import { AuthRequestError, apiFetch, fetchCsrf } from '@/lib/auth-client';

/** Mensajes para la persona: qué pasó y cómo seguir; nunca códigos ni detalles del protocolo. */
function messageFor(error: unknown): string {
  if (!(error instanceof AuthRequestError))
    return 'No pudimos conectar. Revisa tu conexión e inténtalo de nuevo.';
  if (error.code === 'TENANT_RESTRICTED')
    return 'La empresa no puede añadir personas en este momento. Avisa a quien te invitó.';
  if (error.code === 'FORBIDDEN')
    return 'Iniciaste sesión con otra cuenta. Cierra la sesión y entra con el correo invitado.';
  if (error.status === 401) return 'La contraseña no es correcta. Revísala e inténtalo de nuevo.';
  if (error.status === 429)
    return 'Hiciste demasiados intentos. Espera unos minutos antes de volver a intentarlo.';
  if (error.status === 400) return error.message; // política de contraseñas: el servidor explica el motivo
  return 'No pudimos aceptar la invitación. Inténtalo de nuevo.';
}

/**
 * Lógica de la invitación (Fase 4.3b). El token llega en el fragmento (#), que no viaja al servidor ni al Referer;
 * se quita de la barra de direcciones en cuanto se lee.
 */
export function InvitationFlow() {
  const [token, setToken] = useState('');
  const [state, setState] = useState<InvitationState>({ kind: 'loading' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<InvitationFieldErrors>({});

  useEffect(() => {
    const value = window.location.hash.slice(1);
    window.history.replaceState(null, '', window.location.pathname);
    setToken(value);
    if (!value) {
      setState({ kind: 'invalid' });
      return;
    }
    (async () => {
      try {
        const csrf = await fetchCsrf('/api/v1/hub/csrf');
        const res = await apiFetch('/api/v1/hub/invitations/preview', {
          method: 'POST',
          csrf,
          body: JSON.stringify({ token: value }),
        });
        const preview = HubInvitationPreviewSchema.parse(await res.json());
        const signedIn = await apiFetch('/api/v1/hub/me/memberships').then(
          () => true,
          () => false,
        );
        setState({
          kind: 'ready',
          company: preview.tradeName,
          email: preview.email,
          signedIn,
          mode: 'register',
        });
      } catch (e) {
        setState({ kind: e instanceof AuthRequestError && e.status === 404 ? 'invalid' : 'error' });
      }
    })();
  }, []);

  function onModeChange(mode: InvitationMode) {
    if (state.kind !== 'ready') return;
    setError(null);
    setFieldErrors({});
    setState({ ...state, mode });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== 'ready') return;
    const form = new FormData(event.currentTarget);
    const fullName = String(form.get('fullName') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const confirm = String(form.get('confirm') ?? '');
    const register = !state.signedIn && state.mode === 'register';
    const errors: InvitationFieldErrors = state.signedIn
      ? {}
      : register
        ? {
            fullName: fullName.length >= 2 ? null : 'Escribe tu nombre.',
            password: password.length >= 10 ? null : 'Usa al menos 10 caracteres.',
            confirm: confirm === password ? null : 'Las contraseñas no coinciden.',
          }
        : { password: password ? null : 'Escribe tu contraseña.' };
    setFieldErrors(errors);
    setError(null);
    const first = (['fullName', 'password', 'confirm'] as const).find((k) => errors[k]);
    if (first) {
      const field = event.currentTarget.elements.namedItem(first);
      if (field instanceof HTMLInputElement) field.focus();
      return;
    }
    setSubmitting(true);
    try {
      const csrf = await fetchCsrf('/api/v1/hub/csrf');
      let res: Response;
      if (register) {
        res = await apiFetch('/api/v1/hub/invitations/register', {
          method: 'POST',
          csrf,
          body: JSON.stringify({ token, fullName, password }),
        });
      } else {
        if (!state.signedIn) {
          await apiFetch('/api/v1/hub/login', {
            method: 'POST',
            csrf,
            body: JSON.stringify({ email: state.email, password }),
          });
        }
        res = await apiFetch('/api/v1/hub/invitations/accept', {
          method: 'POST',
          csrf,
          body: JSON.stringify({ token }),
        });
      }
      const accepted = HubInvitationAcceptedSchema.parse(await res.json());
      setState({ kind: 'accepted', company: accepted.tradeName, host: accepted.tenantHost });
    } catch (e) {
      setSubmitting(false);
      if (e instanceof AuthRequestError && e.status === 404) {
        setState({ kind: 'invalid' });
        return;
      }
      if (e instanceof AuthRequestError && e.status === 409 && register) {
        // Ya existe una cuenta con ese correo: se pasa a iniciar sesión.
        setState({ ...state, mode: 'login' });
        setError('Ya tienes una cuenta YEBO con este correo. Escribe tu contraseña para aceptar.');
        return;
      }
      setError(messageFor(e));
    }
  }

  return (
    <InvitationView
      state={state}
      submitting={submitting}
      error={error}
      fieldErrors={fieldErrors}
      onSubmit={onSubmit}
      onModeChange={onModeChange}
    />
  );
}
