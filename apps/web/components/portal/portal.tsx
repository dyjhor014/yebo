import {
  siteAssetUrl,
  type PublicSiteResponse,
  type SiteConfig,
  type SiteSectionKind,
} from '@yebo/contracts';
import type { ReactNode } from 'react';
import { PORTAL_FONT_VARIABLES } from './fonts';
import { themeStyle } from './theme';

/**
 * Portal público de la empresa (Fase 5.3; F5-Q1: portada informativa). Una sola app y una sola compilación para todas
 * las empresas: lo que cambia es el documento publicado (tema por tokens y contenido). Todo el texto se muestra como
 * texto (React lo escapa); las URL ya llegan validadas (https, tel:, mailto: se construyen aquí).
 */
const MODALITY = { LAND: 'Terrestre', RIVER: 'Fluvial' } as const;
const SERVICE = {
  PASSENGER: 'Pasajeros',
  PARCEL: 'Encomiendas',
  CARGO: 'Carga',
  VEHICLE_TRANSPORT: 'Transporte de vehículos',
} as const;
const SECTION_TITLE: Record<SiteSectionKind, string> = {
  services: 'Servicios',
  branches: 'Sucursales',
  schedule: 'Horarios',
  faq: 'Preguntas frecuentes',
  policies: 'Políticas',
  contact: 'Contacto',
};
const SOCIAL: Record<keyof SiteConfig['social'], string> = {
  website: 'Sitio web',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
};

const digits = (phone: string) => phone.replace(/[^\d+]/g, '');
const LINK =
  'font-semibold text-[var(--site-accent)] underline decoration-1 underline-offset-4 hover:decoration-2';
const BUTTON =
  'inline-flex min-h-11 items-center justify-center rounded-[var(--site-radius)] bg-[var(--site-primary)] px-5 font-semibold text-[var(--site-on-primary)] hover:brightness-95';

/**
 * Los cortes de diseño son de CONTENEDOR (`@container`), no de la ventana: el mismo portal se ve como en un móvil
 * dentro de la vista previa del editor (un iPhone de 390 px o un monitor de 1280 px reducidos) y en la web real.
 * `preview`: sin enlace de salto ni altura mínima de pantalla (va dentro de un marco con su propio desplazamiento).
 */
export function Portal({ site, preview = false }: { site: PublicSiteResponse; preview?: boolean }) {
  const { config } = site.site;
  const name = site.tenant.tradeName;
  const sections = config.sections.filter((s) => s.enabled && hasContent(s.kind, site)).map((s) => s.kind);
  const whatsapp = config.contact.whatsapp;
  const phone = config.contact.phones[0];
  const cta = whatsapp
    ? { href: `https://wa.me/${digits(whatsapp).replace('+', '')}`, label: 'Escríbenos por WhatsApp' }
    : phone
      ? { href: `tel:${digits(phone.number)}`, label: `Llámanos: ${phone.number}` }
      : null;
  const bookable = site.services.some((s) => s.service === 'PASSENGER' || s.service === 'PARCEL');

  return (
    <div
      className={`${PORTAL_FONT_VARIABLES} @container ${preview ? 'min-h-full' : 'min-h-dvh'} bg-[var(--site-bg)] text-[var(--site-text)] [font-family:var(--site-font)]`}
      style={themeStyle(config.theme)}
    >
      {!preview && (
        <a
          href="#contenido"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-10 focus:rounded-[var(--site-radius)] focus:bg-[var(--site-bg)] focus:px-4 focus:py-2"
        >
          Ir al contenido
        </a>
      )}
      <header className="border-b border-[var(--site-line)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 @2xl:px-8">
          {config.logoAssetId ? (
            // Logo ya recodificado por la API (PNG ≤ 1024 px); sin optimización de imagen de Next.
            <img
              src={siteAssetUrl(config.logoAssetId)}
              alt={name}
              className="h-11 w-auto max-w-[14rem] object-contain"
            />
          ) : (
            <span className="text-xl font-bold tracking-tight">{name}</span>
          )}
          {sections.length > 1 && (
            <nav aria-label="Secciones" className="hidden @3xl:block">
              <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[0.9375rem]">
                {sections.map((k) => (
                  <li key={k}>
                    <a
                      href={`#${k}`}
                      className="font-medium text-[var(--site-text)] underline-offset-4 hover:underline"
                    >
                      {SECTION_TITLE[k]}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </header>

      <main id="contenido">
        <section aria-labelledby="portada" className="bg-[var(--site-tint)]">
          <div
            className={`mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 @2xl:px-8 @3xl:py-20 ${config.hero.imageAssetId ? '@3xl:grid-cols-[1.1fr_1fr]' : ''}`}
          >
            <div className="flex max-w-2xl flex-col gap-5">
              <h1
                id="portada"
                className="text-4xl font-bold tracking-[-0.02em] text-balance @3xl:text-5xl @5xl:text-6xl"
              >
                {config.hero.title}
              </h1>
              {config.hero.subtitle && (
                <p className="text-lg text-pretty text-[var(--site-muted)] @3xl:text-xl">
                  {config.hero.subtitle}
                </p>
              )}
              {cta && (
                <div>
                  <a
                    href={cta.href}
                    className={BUTTON}
                    {...(cta.href.startsWith('https:') && { rel: 'noopener noreferrer', target: '_blank' })}
                  >
                    {cta.label}
                  </a>
                </div>
              )}
              {bookable && (
                <p className="text-sm text-[var(--site-muted)]">
                  Reserva de pasajes y seguimiento de envíos en línea: próximamente.
                </p>
              )}
            </div>
            {config.hero.imageAssetId && (
              <img
                src={siteAssetUrl(config.hero.imageAssetId)}
                alt=""
                className="aspect-[3/2] w-full rounded-[var(--site-radius)] object-cover"
              />
            )}
          </div>
        </section>

        {sections.map((kind) => (
          <Section key={kind} kind={kind}>
            <SectionBody kind={kind} site={site} />
          </Section>
        ))}
      </main>

      <footer className="border-t border-[var(--site-line)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-[var(--site-muted)] @2xl:px-8">
          {config.footerText && <p className="text-[var(--site-text)]">{config.footerText}</p>}
          <SocialLinks social={config.social} />
          <p>© {name} · Sitio con la tecnología de YEBO</p>
        </div>
      </footer>
    </div>
  );
}

function hasContent(kind: SiteSectionKind, site: PublicSiteResponse): boolean {
  const c = site.site.config;
  switch (kind) {
    case 'services':
      return site.services.length > 0;
    case 'branches':
      return c.branches.length > 0;
    case 'schedule':
      return c.schedule.length > 0;
    case 'faq':
      return c.faq.length > 0;
    case 'policies':
      return c.policies.length > 0;
    case 'contact':
      return (
        c.contact.phones.length > 0 ||
        c.contact.emails.length > 0 ||
        c.contact.whatsapp !== null ||
        c.contact.address !== null
      );
  }
}

function Section({ kind, children }: { kind: SiteSectionKind; children: ReactNode }) {
  return (
    <section
      id={kind}
      aria-labelledby={`${kind}-t`}
      className="border-t border-[var(--site-line)] first:border-t-0"
    >
      {/* En pantallas anchas, el título a la izquierda y el contenido a la derecha (sin ancho sobrante). */}
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-12 @2xl:px-8 @3xl:py-16 @5xl:grid @5xl:grid-cols-[minmax(0,1fr)_minmax(0,2.6fr)] @5xl:gap-12">
        <h2 id={`${kind}-t`} className="text-2xl font-bold tracking-[-0.01em] @3xl:text-3xl">
          {SECTION_TITLE[kind]}
        </h2>
        {children}
      </div>
    </section>
  );
}

function SectionBody({ kind, site }: { kind: SiteSectionKind; site: PublicSiteResponse }) {
  const c = site.site.config;
  switch (kind) {
    case 'services': {
      const byModality = (['LAND', 'RIVER'] as const)
        .map((m) => ({ m, list: site.services.filter((s) => s.modality === m) }))
        .filter((x) => x.list.length > 0);
      return (
        <div className="grid gap-6 @2xl:grid-cols-2">
          {byModality.map(({ m, list }) => (
            <div key={m} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold tracking-wide text-[var(--site-muted)] uppercase">
                {MODALITY[m]}
              </h3>
              <ul className="flex flex-col divide-y divide-[var(--site-line)] border-y border-[var(--site-line)]">
                {list.map((s) => (
                  <li key={s.service} className="py-3 text-lg font-medium">
                    {SERVICE[s.service]}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      );
    }
    case 'branches':
      return (
        <ul className="grid gap-x-8 gap-y-8 @2xl:grid-cols-2">
          {c.branches.map((b, i) => (
            <li
              key={`${b.name}-${i}`}
              className="flex flex-col gap-1 border-t border-[var(--site-line)] pt-4"
            >
              <h3 className="text-lg font-semibold">{b.name}</h3>
              <p className="text-[var(--site-muted)]">
                {b.address}, {b.city}
              </p>
              {b.hours && <p className="text-[var(--site-muted)]">{b.hours}</p>}
              {b.phone && (
                <a href={`tel:${digits(b.phone)}`} className={`${LINK} w-fit`}>
                  {b.phone}
                </a>
              )}
            </li>
          ))}
        </ul>
      );
    case 'schedule':
      return (
        <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-8 gap-y-3">
          {c.schedule.map((row, i) => (
            <div key={`${row.label}-${i}`} className="contents">
              <dt className="font-semibold">{row.label}</dt>
              <dd className="text-[var(--site-muted)]">{row.value}</dd>
            </div>
          ))}
        </dl>
      );
    case 'faq':
      return (
        <div className="flex max-w-3xl flex-col divide-y divide-[var(--site-line)] border-y border-[var(--site-line)]">
          {c.faq.map((q, i) => (
            <details key={i} className="group py-1">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 text-lg font-semibold">
                {q.question}
                <Chevron />
              </summary>
              <p className="pb-4 whitespace-pre-line text-[var(--site-muted)]">{q.answer}</p>
            </details>
          ))}
        </div>
      );
    case 'policies':
      return (
        <div className="flex max-w-3xl flex-col divide-y divide-[var(--site-line)] border-y border-[var(--site-line)]">
          {c.policies.map((p, i) => (
            <details key={i} className="group py-1">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 text-lg font-semibold">
                {p.title}
                <Chevron />
              </summary>
              <p className="pb-4 whitespace-pre-line text-[var(--site-muted)]">{p.body}</p>
            </details>
          ))}
        </div>
      );
    case 'contact':
      return (
        <div className="grid gap-8 @2xl:grid-cols-2">
          <ul className="flex flex-col gap-3">
            {c.contact.phones.map((p, i) => (
              <li key={i}>
                <span className="block text-sm text-[var(--site-muted)]">{p.label}</span>
                <a href={`tel:${digits(p.number)}`} className={LINK}>
                  {p.number}
                </a>
              </li>
            ))}
            {c.contact.whatsapp && (
              <li>
                <span className="block text-sm text-[var(--site-muted)]">WhatsApp</span>
                <a
                  href={`https://wa.me/${digits(c.contact.whatsapp).replace('+', '')}`}
                  rel="noopener noreferrer"
                  target="_blank"
                  className={LINK}
                >
                  {c.contact.whatsapp}
                </a>
              </li>
            )}
            {c.contact.emails.map((e) => (
              <li key={e}>
                <span className="block text-sm text-[var(--site-muted)]">Correo</span>
                <a href={`mailto:${e}`} className={LINK}>
                  {e}
                </a>
              </li>
            ))}
          </ul>
          {c.contact.address && (
            <div>
              <span className="block text-sm text-[var(--site-muted)]">Dirección</span>
              <p className="text-lg">{c.contact.address}</p>
            </div>
          )}
        </div>
      );
  }
}

function SocialLinks({ social }: { social: SiteConfig['social'] }) {
  const entries = (Object.keys(SOCIAL) as (keyof SiteConfig['social'])[]).filter((k) => social[k]);
  if (entries.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Redes y sitio web">
      {entries.map((k) => (
        <li key={k}>
          <a href={social[k] as string} rel="noopener noreferrer" target="_blank" className={LINK}>
            {SOCIAL[k]}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Indicador de abrir y cerrar de FAQ y políticas: dibujado (no un carácter), gira al abrir. */
function Chevron() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-5 shrink-0 text-[var(--site-muted)] transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
    >
      <path d="m5 7.5 5 5 5-5" />
    </svg>
  );
}
