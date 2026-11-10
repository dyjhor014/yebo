'use client';

import {
  CreateTenantResponseSchema,
  PlansResponseSchema,
  type CreateTenantResponse,
  type Plan,
} from '@yebo/contracts';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { OneTimeLink } from '@/components/one-time-link';
import { can, useSession } from '@/components/session';
import { Alert, INPUT, Input, LINK, PRIMARY, SECONDARY, Select, Success } from '@/components/ui';
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
  const formRef = useRef<HTMLFormElement>(null);
  const slugId = useId();

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
    // Sin nombre comercial aún, el subdominio no tiene de dónde salir: el error del nombre basta.
    slug:
      (tradeName.trim() || slugEdited) && !validSlug(finalSlug)
        ? 'De 3 a 40 letras minúsculas, números y guiones simples.'
        : null,
    plan: !versionId ? 'Elige un plan publicado.' : null,
    services: services.length === 0 ? 'Elige al menos un servicio.' : null,
    adminEmail:
      adminEmail.trim() && !EMAIL.test(adminEmail.trim()) ? 'Escribe un correo válido o déjalo vacío.' : null,
  };
  const show = (k: keyof typeof errors) => (tried ? errors[k] : null);
  const published = (plans ?? []).flatMap((p) =>
    p.versions.filter((v) => v.status === 'PUBLISHED').map((v) => ({ p, v })),
  );
  const chosen = published.find((x) => x.v.id === versionId);

  async function create() {
    setTried(true);
    if (Object.values(errors).some(Boolean) || !validSlug(finalSlug)) {
      // Lleva el foco al primer campo con error (tras pintar los mensajes).
      requestAnimationFrame(() => {
        const form = formRef.current;
        const target =
          form?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
          (errors.services ? form?.querySelector<HTMLElement>('input[type="checkbox"]') : null);
        target?.focus();
      });
      return;
    }
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
      <div className="flex flex-col gap-1">
        <nav aria-label="Ruta" className="text-sm text-ink-muted">
          <Link href="/empresas" className={LINK}>
            Empresas
          </Link>{' '}
          <span aria-hidden="true">/</span> <span aria-current="page">Nueva empresa</span>
        </nav>
        <h1 className="font-display text-[1.875rem] font-extrabold tracking-[-0.02em]">Nueva empresa</h1>
      </div>
      {/*
        Dos columnas desde 1280 px para que el formulario entero (con «Dar de alta») quepa sin desplazar:
        izquierda, quién es la empresa; derecha, qué contrata y qué opera. Por debajo, una columna (más legible
        que dos columnas estrechas que cortan el RUC y los nombres).
      */}
      <form
        ref={formRef}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        className="flex max-w-[44rem] flex-col gap-5 xl:max-w-[76rem]"
      >
        {failure && <Alert>{failure}</Alert>}
        <div className="grid items-start gap-5 xl:grid-cols-2">
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
            <div className="grid gap-4 sm:grid-cols-[11rem_1fr]">
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
            {/* Subdominio con el dominio base pegado a la derecha: se ve la dirección completa sin repetirla. */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={slugId} className="text-sm font-medium">
                Subdominio
              </label>
              <div className="flex items-stretch">
                <input
                  id={slugId}
                  value={finalSlug}
                  onChange={(e) => {
                    setSlugEdited(true);
                    setSlug(e.target.value.toLowerCase());
                  }}
                  spellCheck={false}
                  autoCapitalize="none"
                  aria-invalid={show('slug') ? true : undefined}
                  aria-describedby={`${slugId}-base ${slugId}-m`}
                  className={`${INPUT} min-w-0 flex-1 rounded-r-none`}
                />
                <span
                  id={`${slugId}-base`}
                  className="flex items-center rounded-r-[var(--radius-control)] border border-l-0 border-control bg-canvas px-3 text-[0.9375rem] whitespace-nowrap text-ink-muted"
                >
                  .{baseDomain()}
                </span>
              </div>
              <span
                id={`${slugId}-m`}
                className={`text-[0.8125rem] ${show('slug') ? 'font-semibold text-danger' : 'text-ink-muted'}`}
              >
                {show('slug') ?? 'Se propone a partir del nombre comercial; puedes cambiarlo.'}
              </span>
            </div>
            <div className="border-t border-divider pt-4">
              <Input
                label="Correo del primer administrador (opcional)"
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                error={show('adminEmail')}
                hint="Recibirá el rol Administrador; el enlace se muestra una sola vez."
              />
            </div>
          </section>

          <section
            aria-labelledby="s-plan"
            className="flex flex-col gap-4 rounded-xl border border-divider bg-raised p-5"
          >
            <h2 id="s-plan" className="font-display text-lg font-bold">
              Plan y servicios
            </h2>
            {plans !== null && published.length === 0 ? (
              <p
                role="alert"
                className="rounded-[var(--radius-control)] bg-warning-surface px-3.5 py-3 text-sm text-warning"
              >
                No hay planes publicados. Publica una versión en{' '}
                <Link href="/planes" className="font-semibold underline underline-offset-4">
                  Planes
                </Link>{' '}
                antes de dar de alta empresas.
              </p>
            ) : (
              <Select
                label="Plan"
                value={versionId}
                onChange={(e) => setVersionId(e.target.value)}
                error={show('plan')}
                hint={
                  chosen
                    ? `${money(chosen.v.basePrice, chosen.v.currency)} al mes · ${chosen.v.includedUsers} usuarios incluidos · ${money(chosen.v.extraUserPrice, chosen.v.currency)} por adicional · ${
                        chosen.v.trialDays > 0
                          ? `empieza con ${chosen.v.trialDays} días de prueba`
                          : 'sin prueba: empieza «Al día»'
                      }.`
                    : undefined
                }
              >
                {plans === null && <option value="">Cargando planes…</option>}
                {published.map(({ p, v }) => (
                  <option key={v.id} value={v.id}>
                    {p.name} (versión {v.version})
                  </option>
                ))}
              </Select>
            )}
            <fieldset
              className="flex flex-col gap-2"
              aria-describedby={show('services') ? 'srv-error' : undefined}
            >
              <legend className="mb-1 text-sm font-medium">Servicios que opera</legend>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                {MODALITIES.map((m) => (
                  <fieldset key={m} className="flex flex-col">
                    <legend className="mb-1 text-[0.8125rem] font-semibold text-ink-muted capitalize">
                      {MODALITY_LABEL[m]}
                    </legend>
                    {SERVICES.map((s) => {
                      const key = `${m}:${s}`;
                      return (
                        <label
                          key={key}
                          className="-mx-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-control)] px-2 hover:bg-ink/5"
                        >
                          <input
                            type="checkbox"
                            checked={services.includes(key)}
                            onChange={() =>
                              setServices((x) => (x.includes(key) ? x.filter((y) => y !== key) : [...x, key]))
                            }
                            className="size-[1.125rem] shrink-0"
                          />
                          <span className="first-letter:uppercase">{SERVICE_LABEL[s]}</span>
                        </label>
                      );
                    })}
                  </fieldset>
                ))}
              </div>
              {show('services') && (
                <span id="srv-error" className="text-[0.8125rem] font-semibold text-danger">
                  {show('services')}
                </span>
              )}
            </fieldset>
          </section>
        </div>

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
