'use client';

import type { TenantDetail } from '@yebo/contracts';
import { date, today } from '@/lib/format';
import { MODALITY_LABEL, SERVICE_LABEL } from '@/lib/tenants';

const DOMAIN_STATUS = {
  PENDING: 'pendiente de verificar',
  VERIFIED: 'verificado',
  FAILED: 'verificación fallida',
} as const;

/** Pestaña «Resumen»: datos legales, dominios, servicios y fechas clave. */
export function SummaryTab({ tenant }: { tenant: TenantDetail }) {
  const local = (iso: string | null) => (iso ? date(today(tenant.timezone, new Date(iso))) : '—');
  const rows: [string, string][] = [
    ['Razón social', tenant.legalName],
    ['Nombre comercial', tenant.tradeName],
    ['Documento', `${tenant.taxIdType} ${tenant.taxId}`],
    ['Zona horaria', tenant.timezone],
    ['Alta', local(tenant.createdAt)],
    ['Activada', local(tenant.activatedAt)],
    ['Fin de la prueba', local(tenant.trialEndsAt)],
  ];
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section aria-labelledby="datos" className="rounded-xl border border-divider bg-raised">
        <h2 id="datos" className="border-b border-divider px-5 py-4 font-display text-lg font-bold">
          Datos de la empresa
        </h2>
        <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2.5 px-5 py-4 text-[0.9375rem]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-muted">{k}</dt>
              <dd className="font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <div className="flex flex-col gap-5">
        <section aria-labelledby="dominios" className="rounded-xl border border-divider bg-raised">
          <h2 id="dominios" className="border-b border-divider px-5 py-4 font-display text-lg font-bold">
            Dominios
          </h2>
          <ul className="px-5 py-3">
            {tenant.domains.map((d) => (
              <li key={d.host} className="py-1.5">
                <span className="font-medium">{d.host}</span>
                <span className="text-sm text-ink-muted">
                  {' '}
                  · {d.kind === 'SUBDOMAIN' ? 'subdominio' : 'dominio propio'} ·{' '}
                  {DOMAIN_STATUS[d.verificationStatus]}
                  {d.isPrimary && ' · principal'}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="servicios" className="rounded-xl border border-divider bg-raised">
          <h2 id="servicios" className="border-b border-divider px-5 py-4 font-display text-lg font-bold">
            Servicios
          </h2>
          <ul className="px-5 py-3">
            {tenant.services.map((s) => (
              <li key={`${s.modality}:${s.service}`} className="py-1.5">
                <span className="font-medium capitalize">{MODALITY_LABEL[s.modality]}</span> ·{' '}
                {SERVICE_LABEL[s.service]}
                {!s.enabled && <span className="text-sm text-ink-muted"> · desactivado</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
