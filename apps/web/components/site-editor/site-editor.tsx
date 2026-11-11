'use client';

import {
  SITE_MAX_BYTES,
  SITE_SURFACES,
  contrastRatio,
  defaultSiteConfig,
  effectiveSiteConfig,
  siteConfigBytes,
  textOnPrimary,
  themeContrastProblems,
  type PublicSiteResponse,
  type SiteConfig,
  type SiteEditorResponse,
  type SiteSectionKind,
} from '@yebo/contracts';
import { Dialog } from '@yebo/ui/dialog';
import { Input, LINK, PRIMARY, SECONDARY, Select, Textarea } from '@yebo/ui/form';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePanel } from '@/components/panel/panel-session';
import { Portal } from '@/components/portal/portal';
import { errorMessage, getEditor, publishDraft, retireAsset, saveDraft } from '@/lib/site-api';
import {
  EDITOR_TABS,
  FONT_GROUPS,
  SECTION_LABEL,
  changesSince,
  draftIssues,
  normalizeConfig,
  unusedAssets,
  type EditorTab,
} from '@/lib/site-draft';
import { DevicePreview, PreviewZoom, type Device } from './device-preview';
import {
  CARD,
  CARD_TITLE,
  ColorField,
  ImageField,
  ListEditor,
  MoveButtons,
  Pills,
  Tabs,
  fmtRatio,
} from './editor-fields';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Loaded = { editor: SiteEditorResponse; config: SiteConfig; saved: SiteConfig };

/** Lo que se edita: el borrador; si no hay, lo publicado; si nunca se publicó, la configuración inicial. */
function baseOf(editor: SiteEditorResponse, tradeName: string): SiteConfig {
  return editor.draft?.config ?? editor.published?.config ?? defaultSiteConfig(tradeName);
}

/** Parte del portal que muestra cada pestaña, hasta que el foco diga algo más preciso. */
const TAB_PREVIEW: Record<EditorTab, string | null> = {
  theme: 'top',
  hero: 'top',
  sections: null,
  contact: 'contact',
  more: 'schedule',
};

const tabId = (t: EditorTab) => `pestana-${t}`;

/**
 * «Mi sitio» (Fase 5.4, maqueta aprobada y revisada con Impeccable): formulario por partes del sitio y vista previa
 * del borrador en un monitor o un iPhone, con las mismas reglas que el portal (contraste AA y lo que permite el
 * plan). Guardar crea o reemplaza el borrador; publicar lo pone en el portal; el historial permite restaurar.
 */
export function SiteEditor() {
  const { company, can } = usePanel();
  const tradeName = company.tenant.tradeName;
  const [state, setState] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!can('site.manage')) return;
    getEditor()
      .then((editor) => {
        const base = baseOf(editor, tradeName);
        setState({ editor, config: base, saved: base });
      })
      .catch((e: unknown) => setLoadError(errorMessage(e)));
  }, [can, tradeName]);

  if (!can('site.manage')) {
    return (
      <Page>
        <h1 className="font-display text-[1.625rem] font-extrabold tracking-[-0.02em]">Mi sitio</h1>
        <p className="text-ink-muted">Tu acceso no incluye editar el sitio de la empresa.</p>
      </Page>
    );
  }
  if (loadError) {
    return (
      <Page>
        <h1 className="font-display text-[1.625rem] font-extrabold tracking-[-0.02em]">Mi sitio</h1>
        <p
          role="alert"
          className="rounded-[var(--radius-control)] bg-danger-surface px-3.5 py-3 text-sm text-danger"
        >
          {loadError}
        </p>
      </Page>
    );
  }
  if (!state) return <p className="px-6 py-10 text-ink-muted">Cargando «Mi sitio»…</p>;
  return <Editor initial={state} company={company} />;
}

function Page({ children }: { children: ReactNode }) {
  return <div className="flex max-w-2xl flex-col gap-3 px-4 py-8 sm:px-8 lg:px-12">{children}</div>;
}

function Editor({ initial, company }: { initial: Loaded; company: PublicSiteResponse }) {
  const tradeName = company.tenant.tradeName;
  const [editor, setEditor] = useState(initial.editor);
  const [config, setConfig] = useState(initial.config);
  const [saved, setSaved] = useState(initial.saved);
  const [tab, setTab] = useState<EditorTab>('theme');
  const [device, setDevice] = useState<Device>('desktop');
  const [target, setTarget] = useState<string | null>('top');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Tras el primer intento de guardar o publicar con datos por corregir: se marcan los campos y las pestañas. */
  const [showIssues, setShowIssues] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  /** Archivos que el borrador dejó de usar en esta sesión: se retiran después de guardar. */
  const dropped = useRef(new Set<string>());
  const issuesRef = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);

  // Las filas vacías no cuentan: añadir una y no escribir nada no deja «cambios sin guardar».
  const dirty = !same(normalizeConfig(config), normalizeConfig(saved));
  const issues = useMemo(() => draftIssues(config), [config]);
  const hasDraft = editor.draft !== null;
  // Un sitio nunca publicado se puede publicar tal cual (la configuración inicial ya es válida).
  const canPublish = dirty || hasDraft || !editor.published;
  const errors = useMemo(() => {
    const byPath = new Map<string, string>();
    if (showIssues) for (const i of issues) if (!byPath.has(i.path)) byPath.set(i.path, i.message);
    return byPath;
  }, [issues, showIssues]);
  const err = (path: string) => errors.get(path) ?? null;
  const tabErrors = useMemo(() => {
    const out: Partial<Record<EditorTab, number>> = {};
    if (showIssues) for (const i of issues) out[i.tab] = (out[i.tab] ?? 0) + 1;
    return out;
  }, [issues, showIssues]);

  // Aviso al salir con cambios sin guardar.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // La cabecera es fija: la vista previa (también fija) empieza debajo.
  useEffect(() => {
    const el = header.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeaderHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Desde el resumen de problemas: el foco va al campo, ya en su pestaña.
  useEffect(() => {
    if (!focusPath) return;
    document.querySelector<HTMLElement>(`[data-path="${CSS.escape(focusPath)}"]`)?.focus();
    setFocusPath(null);
  }, [focusPath, tab]);

  const update = useCallback((patch: Partial<SiteConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
  }, []);
  const setAsset = (field: 'logo' | 'hero', id: string | null) => {
    const previous = field === 'logo' ? config.logoAssetId : config.hero.imageAssetId;
    if (previous && previous !== id) dropped.current.add(previous);
    if (field === 'logo') update({ logoAssetId: id });
    else update({ hero: { ...config.hero, imageAssetId: id } });
  };
  const changeTab = (t: EditorTab) => {
    setTab(t);
    if (TAB_PREVIEW[t]) setTarget(TAB_PREVIEW[t]);
  };

  /** Muestra los problemas: marca los campos, lleva a la pestaña del primero y enfoca el resumen. */
  function revealIssues() {
    setShowIssues(true);
    changeTab(issues[0]?.tab ?? tab);
    requestAnimationFrame(() => issuesRef.current?.focus());
  }

  /** Guarda el borrador. Devuelve false si hay algo que corregir o la API lo rechaza. */
  async function save(): Promise<boolean> {
    if (issues.length > 0) {
      revealIssues();
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await saveDraft(normalizeConfig(config));
      const next = res.draft?.config ?? normalizeConfig(config);
      setEditor(res);
      setConfig(next);
      setSaved(next);
      setShowIssues(false);
      const unused = unusedAssets(dropped.current, next);
      dropped.current = new Set();
      await Promise.all(unused.map((id) => retireAsset(id).catch(() => undefined)));
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const status = [
    busy
      ? 'Guardando…'
      : dirty
        ? 'Cambios sin guardar'
        : hasDraft
          ? 'Borrador guardado, sin publicar'
          : 'Sin cambios pendientes',
    editor.published ? `versión publicada: ${editor.published.version}` : 'el sitio aún no se ha publicado',
  ].join(' · ');

  const effective = effectiveSiteConfig(normalizeConfig(config), tradeName, editor.whiteLabel);
  const preview: PublicSiteResponse = {
    tenant: company.tenant,
    site: { version: null, config: effective },
    services: company.services,
  };
  const screen = (zoom: boolean) => (
    <DevicePreview
      device={device}
      address={window.location.host}
      dark={effective.theme.surface === 'dark'}
      target={target}
      zoomed={zoom}
    >
      <Portal site={preview} preview />
    </DevicePreview>
  );

  return (
    <>
      <header
        ref={header}
        className="z-20 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-divider bg-raised px-4 py-4 sm:px-8 lg:sticky lg:top-0 lg:px-10"
      >
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-[1.625rem] font-extrabold tracking-[-0.02em]">Mi sitio</h1>
          <p id="estado-sitio" aria-live="polite" className="text-sm text-ink-muted">
            {status}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link href="/panel/sitio/historial" className={`${LINK} inline-flex min-h-11 items-center px-2`}>
            Historial
          </Link>
          {(dirty || (hasDraft && editor.published)) && (
            <button
              type="button"
              onClick={() => setDiscarding(true)}
              className={`${LINK} inline-flex min-h-11 items-center px-2`}
            >
              Descartar…
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !dirty}
            aria-busy={busy || undefined}
            className={SECONDARY}
          >
            {busy ? 'Guardando…' : 'Guardar borrador'}
          </button>
          <button
            type="button"
            onClick={() => (issues.length > 0 ? revealIssues() : setPublishing(true))}
            disabled={busy || !canPublish}
            aria-describedby="estado-sitio"
            className={PRIMARY}
          >
            Publicar…
          </button>
        </div>
        {error && (
          <p
            role="alert"
            className="basis-full rounded-[var(--radius-control)] bg-danger-surface px-3.5 py-3 text-sm text-danger"
          >
            {error}
          </p>
        )}
      </header>

      <div className="flex flex-wrap items-start gap-6 px-4 py-6 sm:px-8 lg:px-10">
        <div
          className="flex max-w-[34rem] min-w-0 flex-[1_1_26rem] flex-col gap-4"
          // La vista previa sigue a la parte que se edita (sección de una lista, contacto, pie…).
          onFocusCapture={(e) => {
            const part = (e.target as HTMLElement).closest<HTMLElement>('[data-preview]')?.dataset.preview;
            if (part) setTarget(part);
          }}
        >
          <Tabs
            label="Partes del sitio"
            value={tab}
            tabs={EDITOR_TABS}
            errors={tabErrors}
            onChange={changeTab}
            idFor={tabId}
          />

          {!editor.whiteLabel && (
            <div
              role="note"
              className="flex gap-2.5 rounded-[var(--radius-control)] bg-warning-surface px-3.5 py-3 text-sm leading-5 text-warning"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                aria-hidden="true"
                className="mt-px size-[1.125rem] shrink-0"
              >
                <rect x="5" y="11" width="14" height="9" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
              <span>
                Tu plan no incluye <strong>Marca propia</strong>: puedes prepararlo todo, pero el portal
                mostrará el tema YEBO, tu nombre como título y solo servicios, sucursales y contacto. Lo
                guardado se publica en cuanto lo contrates.
              </span>
            </div>
          )}

          {showIssues && issues.length > 0 && (
            <div
              ref={issuesRef}
              tabIndex={-1}
              role="alert"
              className="flex flex-col gap-2 rounded-[var(--radius-control)] bg-danger-surface px-3.5 py-3 text-sm text-danger"
            >
              <p className="font-semibold">
                {issues.length === 1 ? 'Corrige este dato' : `Corrige estos ${issues.length} datos`} para
                guardar o publicar:
              </p>
              <ul className="flex flex-col gap-1">
                {issues.map((i, n) => (
                  <li key={n}>
                    <button
                      type="button"
                      onClick={() => {
                        changeTab(i.tab);
                        setFocusPath(i.path);
                      }}
                      className="text-left underline underline-offset-4"
                    >
                      {i.label}
                    </button>
                    : {i.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div role="tabpanel" id={`${tabId(tab)}-panel`} aria-labelledby={tabId(tab)}>
            {tab === 'theme' && <ThemeTab config={config} update={update} setAsset={setAsset} />}
            {tab === 'hero' && <HeroTab config={config} update={update} setAsset={setAsset} err={err} />}
            {tab === 'sections' && (
              <SectionsTab config={config} update={update} company={company} go={changeTab} />
            )}
            {tab === 'contact' && <ContactTab config={config} update={update} err={err} />}
            {tab === 'more' && <MoreTab config={config} update={update} err={err} />}
          </div>
        </div>

        <section
          aria-labelledby="vista-previa"
          className="flex min-w-0 flex-[999_1_30rem] flex-col gap-3.5 xl:sticky"
          style={{ top: headerHeight + 16 }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <h2 id="vista-previa" className="text-sm font-semibold">
                Vista previa del borrador
              </h2>
              <p className="text-[0.8125rem] text-ink-muted">
                {editor.whiteLabel
                  ? 'Así se verá al publicar. Sigue a la parte que editas.'
                  : 'Lo que se publicaría con tu plan actual.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Pills
                label="Dispositivo de la vista previa"
                value={device}
                onChange={setDevice}
                options={[
                  { value: 'desktop', label: 'Escritorio' },
                  { value: 'phone', label: 'iPhone' },
                ]}
              />
              <button
                type="button"
                onClick={() => setZoomed(true)}
                className={`${LINK} inline-flex min-h-11 items-center px-2 text-sm`}
              >
                Ampliar
              </button>
            </div>
          </div>
          {!zoomed && screen(false)}
        </section>
      </div>

      {zoomed && (
        <PreviewZoom title="Vista previa del borrador" onClose={() => setZoomed(false)}>
          {screen(true)}
        </PreviewZoom>
      )}

      {discarding && (
        <DiscardDialog
          dirty={dirty}
          published={editor.published?.config ?? null}
          hasDraft={hasDraft}
          onClose={() => setDiscarding(false)}
          onDiscard={(to) => {
            setConfig(to === 'saved' ? saved : (editor.published?.config ?? saved));
            setShowIssues(false);
            setDiscarding(false);
          }}
        />
      )}

      {publishing && (
        <PublishDialog
          config={normalizeConfig(config)}
          published={editor.published?.config ?? null}
          nextVersion={editor.draft?.version ?? (editor.published?.version ?? 0) + 1}
          dirty={dirty}
          needsSave={dirty || !hasDraft}
          save={save}
          onClose={() => setPublishing(false)}
          onPublished={(res) => {
            const base = baseOf(res, tradeName);
            setEditor(res);
            setConfig(base);
            setSaved(base);
          }}
        />
      )}
    </>
  );
}

type TabProps = { config: SiteConfig; update: (patch: Partial<SiteConfig>) => void };
type AssetProps = { setAsset: (field: 'logo' | 'hero', id: string | null) => void };
type ErrProps = { err: (path: string) => string | null };

function ThemeTab({ config, update, setAsset }: TabProps & AssetProps) {
  const t = config.theme;
  const problems = themeContrastProblems(t);
  const problem = (f: 'primary' | 'accent') => problems.find((p) => p.field === f)?.message ?? null;
  const setTheme = (patch: Partial<SiteConfig['theme']>) => update({ theme: { ...t, ...patch } });
  const surface = SITE_SURFACES[t.surface].background;
  return (
    <section aria-labelledby="t-tema" className={CARD} data-preview="top">
      <h2 id="t-tema" className={CARD_TITLE}>
        Marca
      </h2>
      <ImageField
        kind="logo"
        label="Logo"
        hint="PNG, JPEG o WebP · mín. 64 × 64 px · máx. 5 MB. Con él generamos el icono de la pestaña."
        assetId={config.logoAssetId}
        onChange={(id) => setAsset('logo', id)}
      />
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Fondo del sitio</span>
        <Pills
          label="Fondo del sitio"
          value={t.surface}
          onChange={(surface) => setTheme({ surface })}
          options={[
            { value: 'light', label: 'Claro' },
            { value: 'dark', label: 'Oscuro' },
          ]}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <ColorField
          label="Color principal"
          hint="Botones y llamada a la acción."
          path="theme.primary"
          value={t.primary}
          onChange={(primary) => setTheme({ primary })}
          ok={!problem('primary')}
          okText={`Los botones se leen bien (${fmtRatio(contrastRatio(t.primary, textOnPrimary(t.primary)))}:1).`}
          problem={problem('primary')}
        />
        <ColorField
          label="Color de acento"
          hint="Enlaces y detalles sobre el fondo."
          path="theme.accent"
          value={t.accent}
          onChange={(accent) => setTheme({ accent })}
          ok={!problem('accent')}
          okText={`Los enlaces se leen bien (${fmtRatio(contrastRatio(t.accent, surface))}:1).`}
          problem={problem('accent')}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label="Tipografía"
          value={t.font}
          onChange={(e) => setTheme({ font: e.target.value as typeof t.font })}
        >
          {FONT_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.fonts.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <Select
          label="Esquinas"
          value={t.radius}
          onChange={(e) => setTheme({ radius: e.target.value as typeof t.radius })}
        >
          <option value="square">Rectas</option>
          <option value="soft">Suaves</option>
          <option value="round">Redondeadas</option>
        </Select>
      </div>
    </section>
  );
}

function HeroTab({ config, update, setAsset, err }: TabProps & AssetProps & ErrProps) {
  const h = config.hero;
  return (
    <section aria-labelledby="t-portada" className={CARD} data-preview="top">
      <h2 id="t-portada" className={CARD_TITLE}>
        Portada
      </h2>
      <Input
        label="Título"
        value={h.title}
        maxLength={80}
        data-path="hero.title"
        error={err('hero.title')}
        hint={`${h.title.length} de 80 caracteres`}
        onChange={(e) => update({ hero: { ...h, title: e.target.value } })}
      />
      <Textarea
        label="Subtítulo (opcional)"
        value={h.subtitle}
        maxLength={240}
        rows={3}
        data-path="hero.subtitle"
        error={err('hero.subtitle')}
        hint={`${h.subtitle.length} de 240 caracteres`}
        onChange={(e) => update({ hero: { ...h, subtitle: e.target.value } })}
      />
      <ImageField
        kind="hero"
        label="Imagen de portada (opcional)"
        hint="PNG, JPEG o WebP · mín. 1200 × 600 px · máx. 5 MB."
        assetId={h.imageAssetId}
        onChange={(id) => setAsset('hero', id)}
      />
    </section>
  );
}

/** Contenido de cada sección: cuánto hay y dónde se añade (los servicios salen de la operación, no del editor). */
const SECTION_CONTENT: Record<SiteSectionKind, { one: string; many: string; tab: EditorTab | null }> = {
  services: { one: 'servicio', many: 'servicios', tab: null },
  branches: { one: 'sucursal', many: 'sucursales', tab: 'contact' },
  schedule: { one: 'horario', many: 'horarios', tab: 'more' },
  faq: { one: 'pregunta', many: 'preguntas', tab: 'more' },
  policies: { one: 'política', many: 'políticas', tab: 'more' },
  contact: { one: 'dato de contacto', many: 'datos de contacto', tab: 'contact' },
};

function SectionsTab({
  config,
  update,
  company,
  go,
}: TabProps & { company: PublicSiteResponse; go: (t: EditorTab) => void }) {
  const amount = (kind: SiteSectionKind): number =>
    ({
      services: company.services.length,
      branches: config.branches.length,
      schedule: config.schedule.length,
      faq: config.faq.length,
      policies: config.policies.length,
      contact:
        config.contact.phones.length +
        config.contact.emails.length +
        (config.contact.whatsapp ? 1 : 0) +
        (config.contact.address ? 1 : 0),
    })[kind];
  const move = (i: number, d: -1 | 1) => {
    const next = [...config.sections];
    const j = i + d;
    const a = next[i];
    const b = next[j];
    if (!a || !b) return;
    next[i] = b;
    next[j] = a;
    update({ sections: next });
  };
  return (
    <section aria-labelledby="t-secciones" className={CARD}>
      <div className="flex flex-col gap-1.5">
        <h2 id="t-secciones" className={CARD_TITLE}>
          Secciones
        </h2>
        <p className="text-sm text-ink-muted">
          Marca las que quieres mostrar y ordénalas: el portal las muestra en este orden, después de la
          portada. Una sección sin contenido no aparece aunque esté marcada.
        </p>
      </div>
      <ol className="flex flex-col gap-2">
        {config.sections.map((s, i) => {
          const n = amount(s.kind);
          const c = SECTION_CONTENT[s.kind];
          return (
            <li
              key={s.kind}
              className="flex min-h-[3.25rem] items-center gap-1 rounded-[var(--radius-control)] border border-divider py-1 pr-1 pl-3"
            >
              {/* Nombre arriba y, debajo, cuánto contenido hay (o dónde añadirlo): filas de la misma altura. */}
              <div className="flex flex-1 flex-col pb-1.5">
                <label className="flex min-h-10 cursor-pointer items-center gap-2.5 text-[0.9375rem] font-semibold">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={() =>
                      update({
                        sections: config.sections.map((x, j) =>
                          j === i ? { ...x, enabled: !x.enabled } : x,
                        ),
                      })
                    }
                    className="size-[1.125rem]"
                  />
                  {SECTION_LABEL[s.kind]}
                </label>
                <span className="pl-7 text-[0.8125rem] leading-6 text-ink-muted">
                  {n > 0 ? (
                    `${n} ${n === 1 ? c.one : c.many}`
                  ) : c.tab ? (
                    <>
                      Sin contenido ·{' '}
                      <button
                        type="button"
                        onClick={() => c.tab && go(c.tab)}
                        aria-label={`Añadir ${c.many}`}
                        className="min-h-6 font-semibold text-ink underline underline-offset-4"
                      >
                        Añadir
                      </button>
                    </>
                  ) : (
                    'Sin servicios activos'
                  )}
                </span>
              </div>
              <MoveButtons
                label={SECTION_LABEL[s.kind]}
                first={i === 0}
                last={i === config.sections.length - 1}
                onMove={(d) => move(i, d)}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ContactTab({ config, update, err }: TabProps & ErrProps) {
  const c = config.contact;
  const setContact = (patch: Partial<SiteConfig['contact']>) => update({ contact: { ...c, ...patch } });
  return (
    <section aria-labelledby="t-contacto" className={CARD}>
      <h2 id="t-contacto" className={CARD_TITLE}>
        Contacto
      </h2>
      <div className="grid gap-4 sm:grid-cols-2" data-preview="contact">
        <Input
          label="WhatsApp (opcional)"
          inputMode="tel"
          value={c.whatsapp ?? ''}
          data-path="contact.whatsapp"
          error={err('contact.whatsapp')}
          hint="Con el código de país, por ejemplo +51 965 432 100. Activa el botón «Escríbenos por WhatsApp»."
          onChange={(e) => setContact({ whatsapp: e.target.value })}
        />
        <Input
          label="Dirección (opcional)"
          value={c.address ?? ''}
          maxLength={200}
          data-path="contact.address"
          error={err('contact.address')}
          onChange={(e) => setContact({ address: e.target.value })}
        />
      </div>
      <ListEditor
        title="Teléfonos"
        noun="teléfono"
        items={c.phones}
        max={6}
        preview="contact"
        make={() => ({ label: '', number: '' })}
        onChange={(phones) => setContact({ phones })}
        render={(p, set, i) => (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Nombre"
              placeholder="Central"
              value={p.label}
              maxLength={40}
              data-path={`contact.phones.${i}.label`}
              error={err(`contact.phones.${i}.label`)}
              onChange={(e) => set({ label: e.target.value })}
            />
            <Input
              label="Número"
              inputMode="tel"
              value={p.number}
              data-path={`contact.phones.${i}.number`}
              error={err(`contact.phones.${i}.number`)}
              onChange={(e) => set({ number: e.target.value })}
            />
          </div>
        )}
      />
      <ListEditor
        title="Correos"
        noun="correo"
        items={c.emails.map((value) => ({ value }))}
        max={4}
        preview="contact"
        make={() => ({ value: '' })}
        onChange={(list) => setContact({ emails: list.map((x) => x.value) })}
        render={(e, set, i) => (
          <Input
            label="Correo"
            type="email"
            value={e.value}
            data-path={`contact.emails.${i}`}
            error={err(`contact.emails.${i}`)}
            onChange={(ev) => set({ value: ev.target.value })}
          />
        )}
      />
      <ListEditor
        title="Sucursales"
        noun="sucursal"
        items={config.branches}
        max={30}
        preview="branches"
        make={() => ({ name: '', address: '', city: '', phone: null, hours: null })}
        onChange={(branches) => update({ branches })}
        render={(b, set, i) => (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Nombre"
              value={b.name}
              maxLength={80}
              data-path={`branches.${i}.name`}
              error={err(`branches.${i}.name`)}
              onChange={(e) => set({ name: e.target.value })}
            />
            <Input
              label="Ciudad"
              value={b.city}
              maxLength={80}
              data-path={`branches.${i}.city`}
              error={err(`branches.${i}.city`)}
              onChange={(e) => set({ city: e.target.value })}
            />
            <div className="sm:col-span-2">
              <Input
                label="Dirección"
                value={b.address}
                maxLength={200}
                data-path={`branches.${i}.address`}
                error={err(`branches.${i}.address`)}
                onChange={(e) => set({ address: e.target.value })}
              />
            </div>
            <Input
              label="Teléfono (opcional)"
              inputMode="tel"
              value={b.phone ?? ''}
              data-path={`branches.${i}.phone`}
              error={err(`branches.${i}.phone`)}
              onChange={(e) => set({ phone: e.target.value })}
            />
            <Input
              label="Horario (opcional)"
              value={b.hours ?? ''}
              maxLength={120}
              data-path={`branches.${i}.hours`}
              error={err(`branches.${i}.hours`)}
              onChange={(e) => set({ hours: e.target.value })}
            />
          </div>
        )}
      />
    </section>
  );
}

const SOCIAL_FIELDS = [
  ['website', 'Sitio web'],
  ['facebook', 'Facebook'],
  ['instagram', 'Instagram'],
  ['tiktok', 'TikTok'],
  ['youtube', 'YouTube'],
  ['x', 'X'],
] as const;

function MoreTab({ config, update, err }: TabProps & ErrProps) {
  const bytes = siteConfigBytes(normalizeConfig(config));
  return (
    <section aria-labelledby="t-mas" className={CARD}>
      <h2 id="t-mas" className={CARD_TITLE}>
        Información
      </h2>
      <ListEditor
        title="Horarios"
        noun="horario"
        items={config.schedule}
        max={14}
        preview="schedule"
        make={() => ({ label: '', value: '' })}
        onChange={(schedule) => update({ schedule })}
        render={(r, set, i) => (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Trayecto o día"
              placeholder="Pucallpa → Iquitos"
              value={r.label}
              maxLength={40}
              data-path={`schedule.${i}.label`}
              error={err(`schedule.${i}.label`)}
              onChange={(e) => set({ label: e.target.value })}
            />
            <Input
              label="Hora"
              placeholder="Lunes y jueves, 6:00 p. m."
              value={r.value}
              maxLength={80}
              data-path={`schedule.${i}.value`}
              error={err(`schedule.${i}.value`)}
              onChange={(e) => set({ value: e.target.value })}
            />
          </div>
        )}
      />
      <ListEditor
        title="Preguntas frecuentes"
        noun="pregunta"
        items={config.faq}
        max={20}
        preview="faq"
        make={() => ({ question: '', answer: '' })}
        onChange={(faq) => update({ faq })}
        render={(q, set, i) => (
          <>
            <Input
              label="Pregunta"
              value={q.question}
              maxLength={160}
              data-path={`faq.${i}.question`}
              error={err(`faq.${i}.question`)}
              onChange={(e) => set({ question: e.target.value })}
            />
            <Textarea
              label="Respuesta"
              value={q.answer}
              maxLength={1200}
              data-path={`faq.${i}.answer`}
              error={err(`faq.${i}.answer`)}
              onChange={(e) => set({ answer: e.target.value })}
            />
          </>
        )}
      />
      <ListEditor
        title="Políticas"
        noun="política"
        items={config.policies}
        max={10}
        preview="policies"
        make={() => ({ title: '', body: '' })}
        onChange={(policies) => update({ policies })}
        render={(p, set, i) => (
          <>
            <Input
              label="Título"
              value={p.title}
              maxLength={80}
              data-path={`policies.${i}.title`}
              error={err(`policies.${i}.title`)}
              onChange={(e) => set({ title: e.target.value })}
            />
            <Textarea
              label="Texto"
              rows={5}
              value={p.body}
              maxLength={6000}
              data-path={`policies.${i}.body`}
              error={err(`policies.${i}.body`)}
              onChange={(e) => set({ body: e.target.value })}
            />
          </>
        )}
      />
      <div className="flex flex-col gap-3" data-preview="footer">
        <h3 className="text-[0.9375rem] font-semibold">Redes y pie de página</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {SOCIAL_FIELDS.map(([key, label]) => (
            <Input
              key={key}
              label={`${label} (opcional)`}
              type="url"
              placeholder="https://"
              value={config.social[key] ?? ''}
              data-path={`social.${key}`}
              error={err(`social.${key}`)}
              onChange={(e) => update({ social: { ...config.social, [key]: e.target.value } })}
            />
          ))}
        </div>
        <Input
          label="Texto del pie (opcional)"
          value={config.footerText ?? ''}
          maxLength={300}
          data-path="footerText"
          error={err('footerText')}
          hint="Por ejemplo, la razón social y el RUC."
          onChange={(e) => update({ footerText: e.target.value })}
        />
      </div>
      {/* El límite solo importa cerca de alcanzarlo. */}
      {bytes > SITE_MAX_BYTES * 0.7 && (
        <p className="text-[0.8125rem] font-semibold text-warning">
          El sitio ocupa {Math.ceil(bytes / 1000)} KB de {SITE_MAX_BYTES / 1000} KB: acorta las políticas o
          las preguntas si necesitas añadir más.
        </p>
      )}
    </section>
  );
}

/** Descartar: volver a lo guardado (cambios de esta edición) o a la versión publicada (también el borrador). */
function DiscardDialog({
  dirty,
  published,
  hasDraft,
  onClose,
  onDiscard,
}: {
  dirty: boolean;
  published: SiteConfig | null;
  hasDraft: boolean;
  onClose: () => void;
  onDiscard: (to: 'saved' | 'published') => void;
}) {
  return (
    <Dialog title="¿Descartar cambios?" onRequestClose={onClose}>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[0.9375rem] leading-[1.375rem]">
        {dirty && (
          <li>
            <strong>Volver a lo guardado</strong> deshace lo que cambiaste desde que guardaste por última vez.
          </li>
        )}
        {published && (hasDraft || dirty) && (
          <li>
            <strong>Volver a lo publicado</strong> carga en el editor la versión que ven tus clientes; tu
            borrador se reemplaza cuando guardes.
          </li>
        )}
      </ul>
      <div className="flex flex-wrap justify-end gap-3">
        <button type="button" onClick={onClose} className={SECONDARY}>
          Seguir editando
        </button>
        {published && (hasDraft || dirty) && (
          <button type="button" onClick={() => onDiscard('published')} className={SECONDARY}>
            Volver a lo publicado
          </button>
        )}
        {dirty && (
          <button type="button" onClick={() => onDiscard('saved')} className={PRIMARY}>
            Volver a lo guardado
          </button>
        )}
      </div>
    </Dialog>
  );
}

function PublishDialog({
  config,
  published,
  nextVersion,
  dirty,
  needsSave,
  save,
  onClose,
  onPublished,
}: {
  config: SiteConfig;
  published: SiteConfig | null;
  nextVersion: number;
  dirty: boolean;
  /** Hay que guardar antes: cambios sin guardar, o un sitio nunca publicado que se publica tal cual. */
  needsSave: boolean;
  save: () => Promise<boolean>;
  onClose: () => void;
  onPublished: (res: SiteEditorResponse) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const changes = useMemo(() => changesSince(config, published), [config, published]);
  const host = window.location.host;
  async function publish() {
    setBusy(true);
    setError(null);
    try {
      if (needsSave && !(await save())) {
        setError('No se pudo guardar el borrador: revisa los avisos del editor.');
        return;
      }
      const res = await publishDraft();
      onPublished(res);
      setDone(res.published?.version ?? nextVersion);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={done ? 'Sitio publicado' : '¿Publicar el borrador?'}
      description={`${host} · el portal cambia en cuanto publiques.`}
      // Mientras se publica no se cierra (ni con Esc): el resultado se ve aquí.
      onRequestClose={() => !busy && onClose()}
    >
      {done ? (
        <>
          <p
            role="status"
            className="rounded-[var(--radius-control)] bg-action/20 px-3.5 py-3 text-[0.9375rem]"
          >
            Versión {done} publicada. Tus clientes ya la ven en {host}.
          </p>
          <div className="flex flex-wrap justify-end gap-3">
            <a
              href="/"
              target="_blank"
              rel="noopener"
              className={`${LINK} inline-flex min-h-11 items-center px-2`}
            >
              Abrir el portal<span className="sr-only"> (en otra pestaña)</span>
            </a>
            <button type="button" onClick={onClose} className={SECONDARY}>
              Volver al editor
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-semibold">
              {published ? 'Cambios respecto a la versión publicada' : 'Lo que se publica'}
            </p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[0.9375rem] leading-[1.375rem]">
              {changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
          {published && (
            <p className="rounded-[var(--radius-control)] bg-ink/5 px-3.5 py-3 text-sm">
              La versión publicada queda en el historial: puedes volver a ella cuando quieras.
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-[var(--radius-control)] bg-danger-surface px-3.5 py-3 text-sm text-danger"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={onClose} disabled={busy} className={SECONDARY}>
              Seguir editando
            </button>
            <button
              type="button"
              onClick={() => void publish()}
              disabled={busy}
              aria-busy={busy || undefined}
              className={PRIMARY}
            >
              {busy
                ? 'Publicando…'
                : dirty
                  ? `Guardar y publicar la versión ${nextVersion}`
                  : `Publicar la versión ${nextVersion}`}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
