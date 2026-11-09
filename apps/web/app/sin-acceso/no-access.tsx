'use client';

import { HubBrandingResponseSchema, HubMembershipsResponseSchema } from '@yebo/contracts';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { CompaniesView, type CompaniesState } from '@/components/auth/companies-view';
import { AuthRequestError, apiFetch } from '@/lib/auth-client';

/** Selección de empresa y "sin acceso" (identity-and-sessions §3–4): solo las empresas del propio usuario. */
export function NoAccess() {
  const requested = useSearchParams().get('tenant_host');
  const [state, setState] = useState<CompaniesState>({ kind: 'loading' });
  const [requestedName, setRequestedName] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ kind: 'loading' });
    apiFetch('/api/v1/hub/me/memberships')
      .then(async (res) => {
        const parsed = HubMembershipsResponseSchema.safeParse(await res.json());
        setState(parsed.success ? { kind: 'ready', companies: parsed.data.memberships } : { kind: 'error' });
      })
      .catch((e) =>
        setState(
          e instanceof AuthRequestError && e.status === 401 ? { kind: 'signed-out' } : { kind: 'error' },
        ),
      );
  }, []);

  useEffect(() => {
    load();
    if (!requested) return;
    apiFetch(`/api/v1/hub/branding?tenant_host=${encodeURIComponent(requested)}`)
      .then(async (res) => {
        const parsed = HubBrandingResponseSchema.safeParse(await res.json());
        if (parsed.success) setRequestedName(parsed.data.tradeName);
      })
      .catch(() => setRequestedName(null));
  }, [load, requested]);

  return (
    <CompaniesView blocked={Boolean(requested)} blockedCompany={requestedName} state={state} onRetry={load} />
  );
}
