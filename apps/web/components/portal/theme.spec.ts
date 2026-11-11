import {
  SITE_SURFACES,
  SiteConfigSchema,
  contrastRatio,
  defaultSiteConfig,
  effectiveSiteConfig,
  type SiteConfig,
} from '@yebo/contracts';
import { themeStyle } from './theme';

/**
 * Criterio de la Fase 5 (parte sin navegador, en la CI): «Dos portales visualmente distintos sin duplicar apps».
 * El portal es UN componente que pinta el documento publicado con las variables de `themeStyle`; aquí se comprueba
 * que dos documentos publicados distintos dan tokens resueltos distintos con ese mismo código, que todos cumplen el
 * contraste AA con el que la API los validó, y que una empresa sin WHITE_LABEL resuelve el tema YEBO.
 * El E2E (06-portal) comprueba lo mismo en el navegador: misma compilación, estilos calculados y capturas distintos.
 */

const naviera: SiteConfig = {
  ...defaultSiteConfig('Naviera Ucayali'),
  theme: { primary: '#C5F36B', accent: '#16C7B2', surface: 'dark', radius: 'round', font: 'lora' },
};
const ribera: SiteConfig = {
  ...defaultSiteConfig('Ribera Amazónica'),
  theme: { primary: '#0B3D91', accent: '#B42318', surface: 'light', radius: 'square', font: 'montserrat' },
};

type Tokens = Record<string, string>;
const tokens = (c: SiteConfig) => themeStyle(c.theme) as unknown as Tokens;

describe('Criterio de la Fase 5 · tokens del portal', () => {
  it('dos sitios publicados distintos → los mismos tokens con valores distintos, del mismo código', () => {
    for (const c of [naviera, ribera]) expect(SiteConfigSchema.parse(c)).toEqual(c);
    const a = tokens(naviera);
    const b = tokens(ribera);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const key of [
      '--site-bg',
      '--site-text',
      '--site-primary',
      '--site-on-primary',
      '--site-accent',
      '--site-radius',
      '--site-font',
      'colorScheme',
    ]) {
      expect({ key, value: a[key] }).not.toEqual({ key, value: b[key] });
    }
    expect(a['--site-font']).toMatch(/--font-lora/);
    expect(b['--site-font']).toMatch(/--font-montserrat/);
  });

  it('los tokens resueltos cumplen AA: texto sobre el principal y acento sobre el fondo', () => {
    for (const c of [naviera, ribera]) {
      const t = tokens(c);
      expect(contrastRatio(t['--site-primary'] ?? '', t['--site-on-primary'] ?? '')).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(t['--site-accent'] ?? '', t['--site-bg'] ?? '')).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t['--site-text'] ?? '', t['--site-bg'] ?? '')).toBeGreaterThanOrEqual(4.5);
      expect(t['--site-bg']).toBe(SITE_SURFACES[c.theme.surface].background);
    }
  });

  it('sin WHITE_LABEL, lo publicado resuelve el tema YEBO (F5-Q4)', () => {
    const yebo = tokens(defaultSiteConfig('Ribera Amazónica'));
    expect(tokens(effectiveSiteConfig(ribera, 'Ribera Amazónica', false))).toEqual(yebo);
    expect(tokens(effectiveSiteConfig(ribera, 'Ribera Amazónica', true))).toEqual(tokens(ribera));
  });
});
