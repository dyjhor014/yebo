import { SITE_SURFACES, textOnPrimary, type SiteTheme } from '@yebo/contracts';
import type { CSSProperties } from 'react';
import { FONT_STACK } from './font-stacks';

const RADIUS = { square: '0px', soft: '10px', round: '22px' } as const;

/**
 * Tema del sitio → variables CSS del portal (Fase 5.3). Los colores son los VALIDADOS por la API (contraste AA): el
 * texto sobre el principal es navy o blanco según contraste, y el acento solo se usa sobre la superficie pura (que
 * es contra la que se validó). Los tintes (portada, bordes) se derivan con color-mix y nunca llevan texto de acento.
 */
export function themeStyle(theme: SiteTheme): CSSProperties {
  const surface = SITE_SURFACES[theme.surface];
  return {
    '--site-bg': surface.background,
    '--site-text': surface.text,
    '--site-muted': `color-mix(in srgb, ${surface.text} 74%, ${surface.background})`,
    '--site-line': `color-mix(in srgb, ${surface.text} 14%, ${surface.background})`,
    '--site-tint': `color-mix(in srgb, ${theme.primary} 10%, ${surface.background})`,
    '--site-primary': theme.primary,
    '--site-on-primary': textOnPrimary(theme.primary),
    '--site-accent': theme.accent,
    '--site-radius': RADIUS[theme.radius],
    '--site-font': FONT_STACK[theme.font],
    colorScheme: theme.surface,
  } as CSSProperties;
}
