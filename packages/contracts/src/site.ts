import { z } from 'zod';

/**
 * Sitio público de la empresa (Fase 5, white label; data-dictionary §11 `site_versions`).
 * Un documento de configuración versionado: tema por TOKENS (F5-Q3; sin HTML ni CSS libres), portada, secciones
 * en orden, contactos, sucursales, horarios, FAQ, políticas y redes. Todo el texto se muestra como texto.
 */

export const SITE_SCHEMA_VERSION = 1;

/** Fuentes autoalojadas de la lista blanca (F5-Q3). La web las sirve desde su propio dominio. */
export const SITE_FONTS = ['inter', 'manrope', 'nunito-sans', 'source-serif', 'montserrat', 'lora'] as const;
export const SiteFontSchema = z.enum(SITE_FONTS);
export type SiteFont = z.infer<typeof SiteFontSchema>;

export const SITE_SECTION_KINDS = ['services', 'branches', 'schedule', 'faq', 'policies', 'contact'] as const;
export const SiteSectionKindSchema = z.enum(SITE_SECTION_KINDS);
export type SiteSectionKind = z.infer<typeof SiteSectionKindSchema>;

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color en formato #RRGGBB');
const Text = (min: number, max: number) => z.string().trim().min(min).max(max);
/** Solo https: nada de javascript:, data: ni http: (contenido mixto). */
const HttpsUrl = z
  .string()
  .trim()
  .max(300)
  .refine((u) => {
    try {
      return new URL(u).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Usa una dirección que empiece por https://');
const Phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'Teléfono no válido');

export const SiteThemeSchema = z
  .object({
    /** Relleno de la acción principal y de la banda de la cabecera; el texto encima se elige solo (navy o blanco). */
    primary: HexColor,
    /** Enlaces y realces sobre la superficie. */
    accent: HexColor,
    surface: z.enum(['light', 'dark']),
    radius: z.enum(['square', 'soft', 'round']),
    font: SiteFontSchema,
  })
  .strict();
export type SiteTheme = z.infer<typeof SiteThemeSchema>;

export const SiteConfigSchema = z
  .object({
    schemaVersion: z.literal(SITE_SCHEMA_VERSION),
    theme: SiteThemeSchema,
    /** Archivos de la etapa 5.2 (`file_assets` de la misma empresa). */
    logoAssetId: z.uuid().nullable(),
    hero: z
      .object({
        title: Text(1, 80),
        subtitle: Text(0, 240),
        imageAssetId: z.uuid().nullable(),
      })
      .strict(),
    /** Todas las secciones, una vez cada una, en el orden en que se muestran. */
    sections: z
      .array(z.object({ kind: SiteSectionKindSchema, enabled: z.boolean() }).strict())
      .length(SITE_SECTION_KINDS.length)
      .refine((s) => new Set(s.map((x) => x.kind)).size === s.length, 'Cada sección aparece una sola vez'),
    contact: z
      .object({
        phones: z.array(z.object({ label: Text(1, 40), number: Phone }).strict()).max(6),
        emails: z.array(z.email().max(254)).max(4),
        whatsapp: Phone.nullable(),
        address: Text(1, 200).nullable(),
      })
      .strict(),
    branches: z
      .array(
        z
          .object({
            name: Text(1, 80),
            address: Text(1, 200),
            city: Text(1, 80),
            phone: Phone.nullable(),
            hours: Text(1, 120).nullable(),
          })
          .strict(),
      )
      .max(30),
    schedule: z.array(z.object({ label: Text(1, 40), value: Text(1, 80) }).strict()).max(14),
    faq: z.array(z.object({ question: Text(1, 160), answer: Text(1, 1200) }).strict()).max(20),
    policies: z.array(z.object({ title: Text(1, 80), body: Text(1, 6000) }).strict()).max(10),
    social: z
      .object({
        website: HttpsUrl.nullable(),
        facebook: HttpsUrl.nullable(),
        instagram: HttpsUrl.nullable(),
        tiktok: HttpsUrl.nullable(),
        youtube: HttpsUrl.nullable(),
        x: HttpsUrl.nullable(),
      })
      .strict(),
    footerText: Text(1, 300).nullable(),
  })
  .strict();
export type SiteConfig = z.infer<typeof SiteConfigSchema>;

/**
 * Tamaño máximo del documento (UTF-8 del JSON). Los límites de cada campo admiten más que esto en total; la base
 * guarda como mucho 64 KB (CHECK site_versions_values), así que el servidor rechaza antes, con un 400 claro.
 */
export const SITE_MAX_BYTES = 60_000;
export function siteConfigBytes(config: SiteConfig): number {
  return new TextEncoder().encode(JSON.stringify(config)).length;
}

// ---------------------------------------------------------------------------------------------------------------
// Contraste (WCAG 2.1): misma regla en el servidor (que la impone) y en el editor (que avisa antes de guardar).
// ---------------------------------------------------------------------------------------------------------------

/** Superficies del portal según `theme.surface`, y el texto que llevan. */
export const SITE_SURFACES = {
  light: { background: '#FFFFFF', text: '#101D2B' },
  dark: { background: '#101D2B', text: '#F3F6F5' },
} as const;
/** Texto sobre el color principal: el que más contraste dé de los dos. */
export const SITE_ON_PRIMARY = ['#101D2B', '#FFFFFF'] as const;
export const SITE_MIN_CONTRAST = 4.5;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Color del texto que va sobre el principal (navy o blanco, el de más contraste). */
export function textOnPrimary(primary: string): (typeof SITE_ON_PRIMARY)[number] {
  return contrastRatio(primary, SITE_ON_PRIMARY[0]) >= contrastRatio(primary, SITE_ON_PRIMARY[1])
    ? SITE_ON_PRIMARY[0]
    : SITE_ON_PRIMARY[1];
}

export type ThemeProblem = { field: 'primary' | 'accent'; ratio: number; message: string };

/** Problemas de contraste del tema (vacío = válido). Umbral AA de texto normal: 4,5:1. */
export function themeContrastProblems(theme: SiteTheme): ThemeProblem[] {
  const problems: ThemeProblem[] = [];
  const onPrimary = contrastRatio(theme.primary, textOnPrimary(theme.primary));
  if (onPrimary < SITE_MIN_CONTRAST) {
    problems.push({
      field: 'primary',
      ratio: onPrimary,
      message: `El texto sobre el color principal solo llega a ${onPrimary.toFixed(2)}:1 (mínimo 4,5:1). Elige un tono más claro o más oscuro.`,
    });
  }
  const surface = SITE_SURFACES[theme.surface].background;
  const onSurface = contrastRatio(theme.accent, surface);
  if (onSurface < SITE_MIN_CONTRAST) {
    problems.push({
      field: 'accent',
      ratio: onSurface,
      message: `El color de acento sobre la superficie ${theme.surface === 'light' ? 'clara' : 'oscura'} solo llega a ${onSurface.toFixed(2)}:1 (mínimo 4,5:1).`,
    });
  }
  return problems;
}

/** Tema YEBO por defecto (empresas sin el módulo WHITE_LABEL o sin sitio publicado; F5-Q4). */
export const YEBO_DEFAULT_THEME: SiteTheme = {
  primary: '#16C7B2',
  accent: '#101D2B',
  surface: 'light',
  radius: 'soft',
  font: 'inter',
};

/** Configuración inicial de una empresa: su nombre, tema YEBO y las secciones básicas activas. */
export function defaultSiteConfig(tradeName: string): SiteConfig {
  const enabled: ReadonlySet<SiteSectionKind> = new Set(['services', 'branches', 'contact']);
  return {
    schemaVersion: SITE_SCHEMA_VERSION,
    theme: YEBO_DEFAULT_THEME,
    logoAssetId: null,
    hero: { title: tradeName.slice(0, 80), subtitle: '', imageAssetId: null },
    sections: SITE_SECTION_KINDS.map((kind) => ({ kind, enabled: enabled.has(kind) })),
    contact: { phones: [], emails: [], whatsapp: null, address: null },
    branches: [],
    schedule: [],
    faq: [],
    policies: [],
    social: { website: null, facebook: null, instagram: null, tiktok: null, youtube: null, x: null },
    footerText: null,
  };
}

/**
 * Lo que se publica de verdad según el plan (F5-Q4): sin WHITE_LABEL, tema YEBO, portada con el nombre y solo las
 * secciones de servicios, sucursales y contacto; se conservan logo, contactos, sucursales y redes.
 */
export function effectiveSiteConfig(config: SiteConfig, tradeName: string, whiteLabel: boolean): SiteConfig {
  if (whiteLabel) return config;
  const basic: ReadonlySet<SiteSectionKind> = new Set(['services', 'branches', 'contact']);
  return {
    ...config,
    theme: YEBO_DEFAULT_THEME,
    hero: { title: tradeName.slice(0, 80), subtitle: '', imageAssetId: null },
    sections: config.sections.map((s) => ({ kind: s.kind, enabled: s.enabled && basic.has(s.kind) })),
    schedule: [],
    faq: [],
    policies: [],
    footerText: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// API de la empresa (permiso site.manage) y del portal público.
// ---------------------------------------------------------------------------------------------------------------

export const SiteVersionStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
export const SiteVersionSchema = z.object({
  version: z.number().int().positive(),
  status: SiteVersionStatusSchema,
  config: SiteConfigSchema,
  updatedAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
});
export type SiteVersion = z.infer<typeof SiteVersionSchema>;

export const SiteEditorResponseSchema = z.object({
  /** El plan incluye el módulo WHITE_LABEL: tema, portada y secciones propias se publican. */
  whiteLabel: z.boolean(),
  draft: SiteVersionSchema.nullable(),
  published: SiteVersionSchema.nullable(),
});
export type SiteEditorResponse = z.infer<typeof SiteEditorResponseSchema>;

export const SaveSiteDraftRequestSchema = z.object({ config: SiteConfigSchema }).strict();
export type SaveSiteDraftRequest = z.infer<typeof SaveSiteDraftRequestSchema>;

export const SiteVersionsResponseSchema = z.object({
  versions: z.array(SiteVersionSchema.omit({ config: true })),
});
export type SiteVersionsResponse = z.infer<typeof SiteVersionsResponseSchema>;
