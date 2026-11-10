'use client';

import {
  CreateTenantResponseSchema,
  PlansResponseSchema,
  type CreateTenantResponse,
  type Plan,
} from '@yebo/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { OneTimeLink } from '@/components/one-time-link';
import { can, useSession } from '@/components/session';
import { Alert, Input, LINK, PRIMARY, SECONDARY, Select, Success } from '@/components/ui';
import { ApiError, get, post } from '@/lib/api';
import { money } from '@/lib/format';
import { MODALITY_LABEL, SERVICE_LABEL, slugify, validSlug } from '@/lib/tenants';

const MODALITIES = ['LAND', 'RIVER'] as const;
const SERVICES = ['PASSENGER', 'PARCEL', 'CARGO', 'VEHICLE_TRANSPORT'] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Dominio base de las empresas, deducido del host del panel (admin.<base>). Solo para la vista previa. */
const baseDomain = () =>
  typeof window === 'undefined' ? '' : window.location.hostname.split('.').slice(1).join('.');

/** Alta de empresa (Fase 4.3a): datos, plan publicado, servicios y, si se quiere, la invitación del primer administrador. */
export function NewTenant() {
  const session = useSession();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [tradeName, setTradeName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [taxIdType, setTaxIdType] = useState<'RUC' | 'DNI' | 'CE' | 'PASSPORT'>('RUC');
  const [taxId, setTaxId] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [versionId, setVersionId] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [adminEmail, setAdminEmail] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateTenantResponse | null>(null);

  useEffect(() => {
    get('/api/v1/platform/plans', PlansResponseSchema)
      .then((r) => {
        setPlans(r.plans);
        const first = r.plans.flatMap((p) => p.versions).find((v) => v.status === 'PUBLISHED');
        if (first) setVersionId(first.id);
      })
      .catch((e: Error) => setFailure(e.message));
  }, []);

  if (!can(session, 'platform.tenants.manage')) {
    return <p className="text-ink-muted">Solo un superadmin da de alta empresas.</p>;
  }

  const finalSlug = slugEdited ? slug : slugify(tradeName);
  const taxOk =
    taxIdType === 'RUC' ? /^\d{11}$/.test(taxId.trim()) : /^[A-Za-z0-9-]{4,20}$/.test(taxId.trim());
  const errors = {
    tradeName: !tradeName.trim() ? 'Escribe el nombre comercial.' : null,
    legalName: !legalName.trim() ? 'Escribe la razón social.' : null,
    taxId: !taxOk
      ? taxIdType === 'RUC'
        ? 'El RUC tiene 11 dígitos.'
        : 'Entre 4 y 20 letras, números o guiones.'
      : null,
    slug: !validSlug(finalSlug) ? 'De 3 a 40 letras minúsculas, números y guiones simples.' : null,
    plan: !versionId ? 'Elige un plan publicado.' : null,
    services: services.length === 0 ? 'Elige al menos un servicio.' : null,
    adminEmail:
      adminEmail.trim() && !EMAIL.test(adminEmail.trim()) ? 'Escribe un correo válido o déjalo vacío.' : null,
  };
  const show = (k: keyof typeof errors) => (tried ? errors[k] : null);
  const published = (plans ?? []).flatMap((p) =>
    p.versions.filter((v) => v.status === 'PUBLISHED').map((v) => ({ p, v })),
  );

  async function create() {
    setTried(true);
    if (Object.values(errors).some(Boolean)) return;
    setBusy(true);
    setFailure(null);
    try {
      setCreated(
        await post(
          '/api/v1/platform/tenants',
          {
            slug: finalSlug,
            legalName: legalName.trim(),
            tradeName: tradeName.trim(),
            taxIdType,
            taxId: taxId.trim(),
            planVersionId: versionId,
            services: services.map((s) => {
              const [modality, service] = s.split(':');
              return { modality, service };
            }),
            ...(adminEmail.trim() && { firstAdminEmail: adminEmail.trim() }),
          },
          CreateTenantResponseSchema,
        ),
      );
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'No se pudo dar de alta la empresa.');
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="flex max-w-[40rem] flex-col gap-5">
        <h1 className="font-display text-[1.875rem] font-extrabold tracking-[-0.02em]">
          {created.tradeName} ya está dada de alta
        </h1>
        <Success>
          Su subdominio {created.primaryHost ?? created.slug} ya resuelve. Estado inicial:{' '}
          {created.status === 'TRIAL' ? 'en prueba' : 'al día'}.
        </Success>
        {created.firstAdminInvitation ? (
          <OneTimeLink
            label={`Invitación del primer administrador (${created.firstAdminInvitation.email})`}
            link={created.firstAdminInvitation.link}
            onDone={() => window.location.assign(`/empresas/${created.id}`)}
          />
        ) : (
          <Link href={`/empresas/${created.id}`} className={PRIMARY}>
            Ir a la ficha
          </Link>
        )}
      </div>
    );
  }

  return (
    <>
      <nav aria-label="Ruta" className="text-sm text-ink-muted">
        <Link href="/empresas" className={LINK}>
          Empresas
        </Link>{' '}
        <span aria-hidden="true">/</span> <span aria-current="page">Nueva empresa</span>
      </nav>
      <h1 className="font-display text-[1.875rem] font-extrabold tracking-[-0.02em]">Nueva empresa</h1>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        className="flex max-w-[44rem] flex-col gap-6"
      >
        {failure && <Alert>{failure}</Alert>}
        <section
          aria-labelledby="s-datos"
          className="flex flex-col gap-4 rounded-xl border border-divider bg-raised p-5"
        >
          <h2 id="s-datos" className="font-display text-lg font-bold">
            Datos
          </h2>
          <Input
            label="Nombre comercial"
            value={tradeName}
            onChange={(e) => setTradeName(e.target.value)}
            maxLength={120}
            error={show('tradeName')}
          />
          <Input
            label="Razón social"
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            maxLength={200}
            error={show('legalName')}
          />
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <Select
              label="Documento"
              value={taxIdType}
              onChange={(e) => setTaxIdType(e.target.value as typeof taxIdType)}
            >
              <option value="RUC">RUC</option>
              <option value="DNI">DNI</option>
              <option value="CE">Carné de extranjería</option>
              <option value="PASSPORT">Pasaporte</option>
            </Select>
            <Input
              label="Número"
              inputMode={taxIdType === 'RUC' ? 'numeric' : 'text'}
              value={taxId}
              onChange={(e) => setTaxId(e.target.value)}
              error={show('taxId')}
            />
          </div>
          <Input
            label="Subdominio"
            value={finalSlug}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase());
            }}
            error={show('slug')}
            hint={`Será ${finalSlug || '…'}.${baseDomain()}. Se propone a partir del nombre comercial.`}
          />
        </section>

        <section
          aria-labelledby="s-plan"
          className="flex flex-col gap-4 rounded-xl border border-divider bg-raised p-5"
        >
          <h2 id="s-plan" className="font-display text-lg font-bold">
            Plan y servicios
          </h2>
          <Select
            label="Plan"
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
            error={show('plan')}
            hint="Si el plan tiene prueba, la empresa empieza en prueba."
          >
            {plans === null && <option value="">Cargando planes…</option>}
            {published.map(({ p, v }) => (
              <option key={v.id} value={v.id}>
                {p.name} (versión {v.version}) · {money(v.basePrice, v.currency)} · {v.includedUsers} usuarios
                {v.trialDays > 0 ? ` · ${v.trialDays} días de prueba` : ''}
              </option>
            ))}
          </Select>
          <fieldset
            className="flex flex-col gap-2"
            aria-describedby={show('services') ? 'srv-error' : undefined}
          >
            <legend className="mb-1.5 text-sm font-medium">Servicios que opera</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {MODALITIES.flatMap((m) =>
                SERVICES.map((s) => {
                  const key = `${m}:${s}`;
                  return (
                    <label
                      key={key}
                      className="flex min-h-11 items-center gap-2.5 rounded-[var(--radius-control)] border border-divider px-3"
                    >
                      <input
                        type="checkbox"
                        checked={services.includes(key)}
                        onChange={() =>
                          setServices((x) => (x.includes(key) ? x.filter((y) => y !== key) : [...x, key]))
                        }
                        className="size-[1.125rem]"
                      />
                      <span>
                        <span className="capitalize">{MODALITY_LABEL[m]}</span> · {SERVICE_LABEL[s]}
                      </span>
                    </label>
                  );
                }),
              )}
            </div>
            {show('services') && (
              <span id="srv-error" className="text-[0.8125rem] font-semibold text-danger">
                {show('services')}
              </span>
            )}
          </fieldset>
        </section>

        <section
          aria-labelledby="s-admin"
          className="flex flex-col gap-4 rounded-xl border border-divider bg-raised p-5"
        >
          <h2 id="s-admin" className="font-display text-lg font-bold">
            Primer administrador{' '}
            <span className="font-sans text-sm font-normal text-ink-muted">(opcional)</span>
          </h2>
          <Input
            label="Correo"
            type="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            error={show('adminEmail')}
            hint="Recibirá el rol Administrador. El enlace de invitación se muestra una sola vez."
          />
        </section>

        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} aria-busy={busy || undefined} className={PRIMARY}>
            {busy ? 'Dando de alta…' : 'Dar de alta'}
          </button>
          <Link href="/empresas" className={SECONDARY}>
            Cancelar
          </Link>
        </div>
      </form>
    </>
  );
}
