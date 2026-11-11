import { defaultSiteConfig, type SiteConfig } from '@yebo/contracts';
import { changesSince, describePath, draftIssues, normalizeConfig, unusedAssets } from './site-draft';

const base = (): SiteConfig => defaultSiteConfig('Naviera Ucayali');

describe('normalizeConfig', () => {
  it('los opcionales vacíos pasan a null; el resto no cambia', () => {
    const c = base();
    const n = normalizeConfig({
      ...c,
      contact: { ...c.contact, whatsapp: '  ', address: '' },
      branches: [{ name: 'Pucallpa', address: 'Jr. Ucayali 120', city: 'Pucallpa', phone: '', hours: ' ' }],
      social: { ...c.social, facebook: '', website: 'https://naviera.pe' },
      footerText: '',
    });
    expect(n.contact).toMatchObject({ whatsapp: null, address: null });
    expect(n.branches[0]).toMatchObject({ phone: null, hours: null, name: 'Pucallpa' });
    expect(n.social).toMatchObject({ facebook: null, website: 'https://naviera.pe' });
    expect(n.footerText).toBeNull();
  });
});

describe('draftIssues', () => {
  it('un sitio por defecto no tiene problemas', () => {
    expect(draftIssues(base())).toEqual([]);
  });

  it('nombra el campo, su pestaña y el motivo; el contraste bloquea', () => {
    const c = base();
    const issues = draftIssues({
      ...c,
      theme: { ...c.theme, accent: '#C5F36B' }, // lima sobre blanco: 1,2:1
      hero: { ...c.hero, title: '' },
      branches: [{ name: 'Iquitos', address: '', city: 'Iquitos', phone: null, hours: null }],
      social: { ...c.social, facebook: 'http://facebook.com/x' },
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        { tab: 'hero', label: 'Portada · Título', message: 'No puede quedar vacío.', path: 'hero.title' },
        {
          tab: 'contact',
          label: 'Sucursal 1 · Dirección',
          message: 'No puede quedar vacío.',
          path: 'branches.0.address',
        },
        {
          tab: 'more',
          label: 'Redes · Facebook',
          message: 'Usa una dirección que empiece por https://',
          path: 'social.facebook',
        },
        expect.objectContaining({ tab: 'theme', label: 'Color de acento', path: 'theme.accent' }),
      ]),
    );
  });

  it('las filas vacías (recién añadidas) no cuentan; las demás conservan su número en pantalla', () => {
    const c = base();
    const empty = { name: '', address: '', city: '', phone: null, hours: null };
    const config: SiteConfig = {
      ...c,
      branches: [empty, { name: 'Iquitos', address: '', city: 'Iquitos', phone: '', hours: null }],
      faq: [{ question: '', answer: '' }],
      contact: { ...c.contact, phones: [{ label: '', number: ' ' }], emails: [''] },
    };
    expect(draftIssues(config)).toEqual([
      {
        tab: 'contact',
        label: 'Sucursal 2 · Dirección',
        message: 'No puede quedar vacío.',
        path: 'branches.1.address',
      },
    ]);
    const sent = normalizeConfig(config);
    expect(sent.branches).toHaveLength(1);
    expect(sent.faq).toEqual([]);
    expect(sent.contact.phones).toEqual([]);
    expect(sent.contact.emails).toEqual([]);
  });

  it('un teléfono mal escrito dice cómo escribirlo', () => {
    const c = base();
    const [issue] = draftIssues({ ...c, contact: { ...c.contact, whatsapp: 'mi número' } });
    expect(issue).toMatchObject({ path: 'contact.whatsapp', label: 'Contacto · WhatsApp' });
    expect(issue?.message).toMatch(/\+51 965 432 100/);
  });

  it('el tamaño máximo se avisa antes de guardar', () => {
    const c = base();
    const long = 'ñ'.repeat(5500);
    const issues = draftIssues({
      ...c,
      policies: Array.from({ length: 10 }, (_, i) => ({ title: `Política ${i}`, body: long })),
    });
    expect(issues).toEqual([expect.objectContaining({ label: 'Tamaño del sitio' })]);
  });
});

describe('describePath', () => {
  it('rutas de contacto y listas', () => {
    expect(describePath(['contact', 'phones', 1, 'number'])).toEqual({
      tab: 'contact',
      label: 'Contacto · Teléfono 2 · Número',
    });
    expect(describePath(['faq', 0, 'answer'])).toEqual({ tab: 'more', label: 'Pregunta 1 · Respuesta' });
    expect(describePath(['footerText'])).toEqual({ tab: 'more', label: 'Pie de página' });
  });
});

describe('changesSince', () => {
  it('primera publicación: lo que verán los clientes', () => {
    const c = base();
    const first = changesSince(
      { ...c, theme: { ...c.theme, surface: 'dark', font: 'lora' }, logoAssetId: 'logo-1' },
      null,
    );
    expect(first[0]).toBe('Primera publicación del sitio.');
    expect(first).toContain('Portada: «Naviera Ucayali».');
    expect(first).toContain('Tema: fondo oscuro, tipografía Lora y tu logo.');
    expect(first.at(-1)).toMatch(/^Secciones, en este orden: Servicios/);
  });

  it('resume tema, portada y secciones mostradas u ocultas', () => {
    const before = base();
    const after: SiteConfig = {
      ...before,
      theme: { ...before.theme, surface: 'dark', accent: '#16C7B2' },
      hero: { ...before.hero, title: 'Viaja por el Ucayali' },
      sections: before.sections.map((s) =>
        s.kind === 'faq' ? { ...s, enabled: true } : s.kind === 'branches' ? { ...s, enabled: false } : s,
      ),
    };
    expect(changesSince(after, before)).toEqual([
      'Tema: colores, fondo, tipografía o esquinas.',
      'Portada: título «Viaja por el Ucayali».',
      'Secciones: se muestran Preguntas frecuentes; se ocultan Sucursales.',
    ]);
  });

  it('solo el orden de las secciones', () => {
    const before = base();
    const after = { ...before, sections: [...before.sections].reverse() };
    expect(changesSince(after, before)).toEqual(['Secciones: nuevo orden.']);
  });

  it('sin cambios', () => {
    expect(changesSince(base(), base())).toEqual([
      'Sin cambios de contenido: se vuelve a publicar lo mismo.',
    ]);
  });
});

describe('unusedAssets', () => {
  it('descarta lo que el borrador sigue usando y los repetidos', () => {
    const c = { ...base(), logoAssetId: 'logo-2' };
    expect(unusedAssets(['logo-1', 'logo-2', 'logo-1', 'hero-1'], c)).toEqual(['logo-1', 'hero-1']);
  });
});
