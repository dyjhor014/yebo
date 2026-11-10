import {
  SITE_MAX_BYTES,
  SITE_SECTION_KINDS,
  siteConfigBytes,
  SiteConfigSchema,
  contrastRatio,
  defaultSiteConfig,
  effectiveSiteConfig,
  textOnPrimary,
  themeContrastProblems,
  YEBO_DEFAULT_THEME,
} from './site';

describe('contraste del tema (WCAG 2.1)', () => {
  it('calcula la razón como WCAG (valores de referencia)', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // Marca YEBO: navy sobre teal 7,99:1 (semantic.css); el orden de los argumentos no importa.
    expect(contrastRatio('#101D2B', '#16C7B2')).toBeCloseTo(7.99, 1);
    expect(contrastRatio('#16C7B2', '#101D2B')).toBeCloseTo(7.99, 1);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2); // el gris AA límite clásico
  });

  it('elige el texto sobre el principal (navy o blanco) por el mayor contraste', () => {
    expect(textOnPrimary('#16C7B2')).toBe('#101D2B');
    expect(textOnPrimary('#0B3D91')).toBe('#FFFFFF');
    expect(textOnPrimary('#FFD400')).toBe('#101D2B');
  });

  it('el tema YEBO por defecto es válido', () => {
    expect(themeContrastProblems(YEBO_DEFAULT_THEME)).toEqual([]);
  });

  it('rechaza un principal sin texto legible encima y un acento ilegible sobre la superficie', () => {
    // #7F7F7F: navy encima 4,0:1 y blanco 4,0:1 → ninguno llega a 4,5.
    const grey = themeContrastProblems({ ...YEBO_DEFAULT_THEME, primary: '#7F7F7F' });
    expect(grey.map((p) => p.field)).toEqual(['primary']);
    // Acento amarillo sobre superficie clara: 1,4:1; sobre la oscura es válido.
    expect(themeContrastProblems({ ...YEBO_DEFAULT_THEME, accent: '#FFD400' }).map((p) => p.field)).toEqual([
      'accent',
    ]);
    expect(themeContrastProblems({ ...YEBO_DEFAULT_THEME, accent: '#FFD400', surface: 'dark' })).toEqual([]);
    // El acento navy por defecto, sobre la superficie oscura (navy), no se ve.
    expect(themeContrastProblems({ ...YEBO_DEFAULT_THEME, surface: 'dark' }).map((p) => p.field)).toEqual([
      'accent',
    ]);
  });

  it('el umbral es 4,5:1 exacto', () => {
    // #767676 sobre blanco: 4,54 (pasa); #777777: 4,48 (no pasa).
    expect(themeContrastProblems({ ...YEBO_DEFAULT_THEME, accent: '#767676' })).toEqual([]);
    expect(themeContrastProblems({ ...YEBO_DEFAULT_THEME, accent: '#777777' })).toHaveLength(1);
  });
});

describe('configuración del sitio', () => {
  it('la configuración por defecto es válida, con las secciones básicas activas', () => {
    const c = defaultSiteConfig('Naviera Ucayali');
    expect(SiteConfigSchema.parse(c)).toEqual(c);
    expect(c.hero.title).toBe('Naviera Ucayali');
    expect(c.sections.filter((s) => s.enabled).map((s) => s.kind)).toEqual([
      'services',
      'branches',
      'contact',
    ]);
  });

  it('rechaza secciones repetidas o incompletas, URL no https, HTML no interpretable y campos desconocidos', () => {
    const c = defaultSiteConfig('X');
    const bad = (patch: object) => SiteConfigSchema.safeParse({ ...c, ...patch }).success;
    expect(bad({ sections: c.sections.slice(1) })).toBe(false);
    expect(bad({ sections: [...c.sections.slice(1), c.sections[1]] })).toBe(false);
    for (const url of ['javascript:alert(1)', 'http://x.pe', 'data:text/html,hola', 'ftp://x.pe', 'x.pe']) {
      expect(bad({ social: { ...c.social, website: url } })).toBe(false);
    }
    expect(bad({ social: { ...c.social, website: 'https://naviera.pe' } })).toBe(true);
    expect(bad({ theme: { ...c.theme, primary: 'red' } })).toBe(false);
    expect(bad({ theme: { ...c.theme, font: 'comic-sans' } })).toBe(false);
    expect(bad({ css: 'body{}' })).toBe(false);
    expect(bad({ hero: { ...c.hero, title: '' } })).toBe(false);
    expect(bad({ hero: { ...c.hero, title: 'x'.repeat(81) } })).toBe(false);
    expect(bad({ contact: { ...c.contact, phones: [{ label: 'Central', number: 'llámanos' }] } })).toBe(
      false,
    );
    expect(
      bad({ contact: { ...c.contact, phones: [{ label: 'Central', number: '+51 (065) 23-4567' }] } }),
    ).toBe(true);
    expect(SITE_SECTION_KINDS).toHaveLength(6);
  });

  it('sin WHITE_LABEL se publica el tema YEBO, la portada con el nombre y solo las secciones básicas', () => {
    const own = {
      ...defaultSiteConfig('Naviera'),
      theme: { ...YEBO_DEFAULT_THEME, primary: '#0B3D91', accent: '#B42318', font: 'lora' as const },
      hero: { title: 'Viaja por el río', subtitle: 'Desde 1998', imageAssetId: null },
      sections: SITE_SECTION_KINDS.map((kind) => ({ kind, enabled: true })),
      faq: [{ question: '¿Equipaje?', answer: '20 kg' }],
      footerText: 'Gracias',
    };
    const plain = effectiveSiteConfig(own, 'Naviera Ucayali', false);
    expect(plain.theme).toEqual(YEBO_DEFAULT_THEME);
    expect(plain.hero).toEqual({ title: 'Naviera Ucayali', subtitle: '', imageAssetId: null });
    expect(plain.sections.filter((s) => s.enabled).map((s) => s.kind)).toEqual([
      'services',
      'branches',
      'contact',
    ]);
    expect(plain.faq).toEqual([]);
    expect(plain.footerText).toBeNull();
    expect(plain.contact).toEqual(own.contact);
    expect(effectiveSiteConfig(own, 'Naviera Ucayali', true)).toBe(own);
  });
});

describe('tamaño del documento', () => {
  it('cuenta bytes UTF-8 del JSON (una ñ ocupa 2) y el máximo cabe en el CHECK de 64 KB de la base', () => {
    const c = defaultSiteConfig('Ñandú');
    const ascii = siteConfigBytes(defaultSiteConfig('Nandu'));
    expect(siteConfigBytes(c)).toBe(ascii + 2);
    expect(SITE_MAX_BYTES).toBeLessThan(65_536 * 0.95); // margen para la representación jsonb (~1 % mayor)
  });
});
