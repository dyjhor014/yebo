import {
  SITE_MAX_BYTES,
  SiteConfigSchema,
  siteConfigBytes,
  themeContrastProblems,
  type SiteConfig,
  type SiteSectionKind,
} from '@yebo/contracts';

/**
 * Lógica del editor «Mi sitio» (Fase 5.4) sin React: lo que se guarda, por qué no se puede guardar o publicar y qué
 * cambia respecto a lo publicado. El servidor vuelve a validarlo todo; esto solo avisa antes y con palabras claras.
 */

export type EditorTab = 'theme' | 'hero' | 'sections' | 'contact' | 'more';

/** Pestañas del editor: nombres cortos (caben en una fila) y el mismo nombre como título de su tarjeta. */
export const EDITOR_TABS: readonly { id: EditorTab; label: string }[] = [
  { id: 'theme', label: 'Marca' },
  { id: 'hero', label: 'Portada' },
  { id: 'sections', label: 'Secciones' },
  { id: 'contact', label: 'Contacto' },
  { id: 'more', label: 'Información' },
];

export const SECTION_LABEL: Record<SiteSectionKind, string> = {
  services: 'Servicios',
  branches: 'Sucursales',
  schedule: 'Horarios',
  faq: 'Preguntas frecuentes',
  policies: 'Políticas',
  contact: 'Contacto',
};

/** Las 6 fuentes de la lista blanca, por familia (el selector las agrupa así). */
export const FONT_GROUPS: readonly {
  label: string;
  fonts: readonly (readonly [SiteConfig['theme']['font'], string])[];
}[] = [
  {
    label: 'Sin serifa',
    fonts: [
      ['inter', 'Inter'],
      ['manrope', 'Manrope'],
      ['nunito-sans', 'Nunito Sans'],
      ['montserrat', 'Montserrat'],
    ],
  },
  {
    label: 'Con serifa',
    fonts: [
      ['source-serif', 'Source Serif'],
      ['lora', 'Lora'],
    ],
  },
];
const FONT_LABEL = Object.fromEntries(FONT_GROUPS.flatMap((g) => g.fonts)) as Record<string, string>;

const SOCIAL_LABEL: Record<keyof SiteConfig['social'], string> = {
  website: 'Sitio web',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
};

const blank = (v: string | null) => (v === null || v.trim() === '' ? null : v);

/** Listas del documento que se editan por filas, con su ruta. */
const LISTS = ['phones', 'emails', 'branches', 'schedule', 'faq', 'policies'] as const;
type ListName = (typeof LISTS)[number];

const isEmptyRow = (row: unknown): boolean =>
  typeof row === 'string'
    ? row.trim() === ''
    : Object.values(row as Record<string, unknown>).every(
        (v) => v === null || (typeof v === 'string' && v.trim() === ''),
      );

function listOf(config: SiteConfig, name: ListName): unknown[] {
  return name === 'phones' || name === 'emails' ? config.contact[name] : config[name];
}

/**
 * Posición en pantalla de cada fila que se envía: las filas totalmente vacías (recién añadidas y sin escribir) no se
 * envían ni cuentan como errores, así que los índices del documento enviado no coinciden con los de la pantalla.
 */
function keptRows(config: SiteConfig): Record<ListName, number[]> {
  const out = {} as Record<ListName, number[]>;
  for (const name of LISTS) {
    out[name] = listOf(config, name).flatMap((row, i) => (isEmptyRow(row) ? [] : [i]));
  }
  return out;
}

/**
 * Lo que se envía: los campos opcionales vacíos pasan a `null` (el esquema no admite cadenas vacías en ellos) y las
 * filas totalmente vacías de las listas se descartan: guardar a medias no falla por una fila que aún no se rellenó.
 */
export function normalizeConfig(config: SiteConfig): SiteConfig {
  const social = Object.fromEntries(
    Object.entries(config.social).map(([k, v]) => [k, blank(v)]),
  ) as SiteConfig['social'];
  const keep = <T>(rows: T[]) => rows.filter((r) => !isEmptyRow(r));
  return {
    ...config,
    contact: {
      ...config.contact,
      phones: keep(config.contact.phones),
      emails: keep(config.contact.emails),
      whatsapp: blank(config.contact.whatsapp),
      address: blank(config.contact.address),
    },
    branches: keep(config.branches).map((b) => ({ ...b, phone: blank(b.phone), hours: blank(b.hours) })),
    schedule: keep(config.schedule),
    faq: keep(config.faq),
    policies: keep(config.policies),
    social,
    footerText: blank(config.footerText),
  };
}

/**
 * Un problema del borrador: la pestaña donde se corrige, el nombre legible del campo, el motivo y la ruta del campo
 * en pantalla (`branches.0.address`, `theme.accent`), con la que el editor lo marca y le lleva el foco.
 */
export type DraftIssue = { tab: EditorTab; label: string; message: string; path: string };

/** Nombre legible de un campo del documento y la pestaña donde se corrige. */
export function describePath(path: readonly PropertyKey[]): { tab: EditorTab; label: string } {
  const [head, a, b] = path;
  const n = typeof a === 'number' ? a + 1 : 0;
  switch (head) {
    case 'theme':
      return { tab: 'theme', label: 'Tema' };
    case 'logoAssetId':
      return { tab: 'theme', label: 'Logo' };
    case 'hero':
      return {
        tab: 'hero',
        label:
          a === 'title' ? 'Portada · Título' : a === 'subtitle' ? 'Portada · Subtítulo' : 'Portada · Imagen',
      };
    case 'sections':
      return { tab: 'sections', label: 'Secciones' };
    case 'contact': {
      const field = { phones: 'Teléfono', emails: 'Correo', whatsapp: 'WhatsApp', address: 'Dirección' }[
        String(a) as 'phones'
      ];
      const index = typeof b === 'number' ? ` ${b + 1}` : '';
      const part = path[3] === 'label' ? ' · Nombre' : path[3] === 'number' ? ' · Número' : '';
      return { tab: 'contact', label: `Contacto · ${field ?? 'Contacto'}${index}${part}` };
    }
    case 'branches': {
      const field = {
        name: 'Nombre',
        address: 'Dirección',
        city: 'Ciudad',
        phone: 'Teléfono',
        hours: 'Horario',
      }[String(b) as 'name'];
      return { tab: 'contact', label: `Sucursal ${n}${field ? ` · ${field}` : ''}` };
    }
    case 'schedule':
      return {
        tab: 'more',
        label: `Horario ${n}${b === 'label' ? ' · Trayecto o día' : b === 'value' ? ' · Hora' : ''}`,
      };
    case 'faq':
      return {
        tab: 'more',
        label: `Pregunta ${n}${b === 'question' ? ' · Pregunta' : b === 'answer' ? ' · Respuesta' : ''}`,
      };
    case 'policies':
      return {
        tab: 'more',
        label: `Política ${n}${b === 'title' ? ' · Título' : b === 'body' ? ' · Texto' : ''}`,
      };
    case 'social':
      return {
        tab: 'more',
        label: `Redes · ${SOCIAL_LABEL[String(a) as keyof SiteConfig['social']] ?? 'Red'}`,
      };
    case 'footerText':
      return { tab: 'more', label: 'Pie de página' };
    default:
      return { tab: 'theme', label: 'Sitio' };
  }
}

function friendly(code: string, message: string, origin: unknown, path: readonly PropertyKey[]): string {
  const field = path.at(-1);
  if (code === 'too_small' && origin === 'string') return 'No puede quedar vacío.';
  if (code === 'too_big' && origin === 'string') return 'Es demasiado largo.';
  if (message === 'Teléfono no válido') {
    return 'Escribe solo números, espacios o guiones; con el código de país si quieres (por ejemplo, +51 965 432 100).';
  }
  if (path[1] === 'emails' || field === 'email') return 'Escribe un correo como ventas@tuempresa.pe.';
  if (code === 'invalid_format') return message.startsWith('Invalid') ? 'El formato no es válido.' : message;
  return message.startsWith('Invalid') || message.startsWith('Too') ? 'Revisa este dato.' : message;
}

/** Ruta del campo con el índice de la fila EN PANTALLA (el enviado descarta las filas vacías). */
function screenPath(path: readonly PropertyKey[], kept: Record<ListName, number[]>): PropertyKey[] {
  const out = [...path];
  const at = path[0] === 'contact' ? 2 : 1;
  const list = (path[0] === 'contact' ? path[1] : path[0]) as ListName;
  const i = out[at];
  if (LISTS.includes(list) && typeof i === 'number') out[at] = kept[list][i] ?? i;
  return out;
}

/**
 * Problemas que impiden GUARDAR el borrador (forma y tamaño) y los que impiden PUBLICARLO (contraste AA). El
 * servidor rechaza el contraste también al guardar, así que ambos bloquean el guardado.
 */
export function draftIssues(config: SiteConfig): DraftIssue[] {
  const parsed = SiteConfigSchema.safeParse(normalizeConfig(config));
  const kept = keptRows(config);
  const issues: DraftIssue[] = parsed.success
    ? []
    : parsed.error.issues.map((i) => {
        const path = screenPath(i.path, kept);
        return {
          ...describePath(path),
          message: friendly(i.code, i.message, 'origin' in i ? i.origin : undefined, i.path),
          path: path.join('.'),
        };
      });
  for (const p of themeContrastProblems(config.theme)) {
    issues.push({
      tab: 'theme',
      label: p.field === 'primary' ? 'Color principal' : 'Color de acento',
      message: p.message,
      path: `theme.${p.field}`,
    });
  }
  if (parsed.success) {
    const bytes = siteConfigBytes(parsed.data);
    if (bytes > SITE_MAX_BYTES) {
      issues.push({
        tab: 'more',
        label: 'Tamaño del sitio',
        path: 'size',
        message: `Ocupa ${Math.ceil(bytes / 1000)} KB y el máximo es ${SITE_MAX_BYTES / 1000} KB: acorta las políticas o las preguntas frecuentes.`,
      });
    }
  }
  return issues;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Resumen de lo que cambia al publicar, por partes del sitio (para el diálogo de publicar). */
export function changesSince(next: SiteConfig, published: SiteConfig | null): string[] {
  if (!published) {
    // Primera vez: lo que verán los clientes, no una lista de diferencias.
    const shown = next.sections.filter((s) => s.enabled).map((s) => SECTION_LABEL[s.kind]);
    return [
      'Primera publicación del sitio.',
      `Portada: «${next.hero.title}».`,
      `Tema: fondo ${next.theme.surface === 'light' ? 'claro' : 'oscuro'}, tipografía ${FONT_LABEL[next.theme.font] ?? next.theme.font}${next.logoAssetId ? ' y tu logo' : ''}.`,
      shown.length > 0
        ? `Secciones, en este orden: ${shown.join(', ')} (las que no tengan contenido no aparecen).`
        : 'Sin secciones activas: solo la portada y el pie.',
    ];
  }
  const out: string[] = [];
  if (!same(next.theme, published.theme)) out.push('Tema: colores, fondo, tipografía o esquinas.');
  if (next.logoAssetId !== published.logoAssetId) {
    out.push(next.logoAssetId ? 'Logo nuevo.' : 'Se quita el logo.');
  }
  if (next.hero.title !== published.hero.title) out.push(`Portada: título «${next.hero.title}».`);
  if (next.hero.subtitle !== published.hero.subtitle) out.push('Portada: subtítulo.');
  if (next.hero.imageAssetId !== published.hero.imageAssetId) {
    out.push(next.hero.imageAssetId ? 'Portada: imagen nueva.' : 'Portada: se quita la imagen.');
  }
  if (!same(next.sections, published.sections)) {
    const was = new Map(published.sections.map((s) => [s.kind, s.enabled]));
    const shown = next.sections
      .filter((s) => s.enabled && !was.get(s.kind))
      .map((s) => SECTION_LABEL[s.kind]);
    const hidden = next.sections
      .filter((s) => !s.enabled && was.get(s.kind))
      .map((s) => SECTION_LABEL[s.kind]);
    const parts = [
      shown.length > 0 ? `se muestran ${shown.join(', ')}` : '',
      hidden.length > 0 ? `se ocultan ${hidden.join(', ')}` : '',
    ].filter(Boolean);
    out.push(parts.length > 0 ? `Secciones: ${parts.join('; ')}.` : 'Secciones: nuevo orden.');
  }
  if (!same(next.contact, published.contact)) out.push('Contacto.');
  if (!same(next.branches, published.branches)) out.push(`Sucursales (${next.branches.length}).`);
  if (!same(next.schedule, published.schedule)) out.push('Horarios.');
  if (!same(next.faq, published.faq)) out.push('Preguntas frecuentes.');
  if (!same(next.policies, published.policies)) out.push('Políticas.');
  if (!same(next.social, published.social) || next.footerText !== published.footerText) {
    out.push('Redes y pie de página.');
  }
  return out.length > 0 ? out : ['Sin cambios de contenido: se vuelve a publicar lo mismo.'];
}

/** Archivos que el borrador ya no usa, para retirarlos tras guardar (el servidor no retira lo publicado). */
export function unusedAssets(candidates: Iterable<string>, config: SiteConfig): string[] {
  return [...new Set(candidates)].filter(
    (id) => id !== config.logoAssetId && id !== config.hero.imageAssetId,
  );
}
