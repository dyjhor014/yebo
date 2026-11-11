import { expect, test, type Browser } from '@playwright/test';
import { SiteConfigSchema, defaultSiteConfig, themeContrastProblems, type SiteConfig } from '@yebo/contracts';
import { expectAccessible, expectNoHorizontalScroll } from '../support/a11y';
import { apiPost } from '../support/api';
import { withDb } from '../support/db';
import { E2E, hostUrl } from '../support/env';

/**
 * Fase 5.3 · Portal público en apps/web (F5-Q1): la MISMA compilación sirve a cada empresa por su host con su
 * sitio publicado. Naviera Ucayali (con WHITE_LABEL) publica un tema propio; Transportes del Oriente (sin el módulo)
 * publica lo básico con el tema YEBO (F5-Q4). Hub → login; host desconocido → 404; /estado se conserva (F5-Q6).
 */
test.describe.configure({ mode: 'serial' });

const NAVIERA = `naviera-ucayali.${E2E.baseDomain}`;
const ORIENTE = `transportes-oriente.${E2E.baseDomain}`;

const navieraSite: SiteConfig = {
  ...defaultSiteConfig('Naviera Ucayali'),
  theme: { primary: '#C5F36B', accent: '#16C7B2', surface: 'dark', radius: 'round', font: 'lora' },
  hero: {
    title: 'Viaja por el Ucayali',
    subtitle: 'Pasajeros y carga entre Pucallpa e Iquitos desde 1998.',
    imageAssetId: null,
  },
  sections: [
    { kind: 'services', enabled: true },
    { kind: 'schedule', enabled: true },
    { kind: 'branches', enabled: true },
    { kind: 'faq', enabled: true },
    { kind: 'policies', enabled: true },
    { kind: 'contact', enabled: true },
  ],
  contact: {
    phones: [{ label: 'Central', number: '+51 61 571234' }],
    emails: ['reservas@naviera-ucayali.pe'],
    whatsapp: '+51 961 234 567',
    address: 'Jr. Ucayali 120, Pucallpa',
  },
  branches: [
    {
      name: 'Pucallpa',
      address: 'Jr. Ucayali 120',
      city: 'Pucallpa',
      phone: '+51 61 571234',
      hours: 'Lun–Sáb 7:00–19:00',
    },
    { name: 'Iquitos', address: 'Av. La Marina 455', city: 'Iquitos', phone: null, hours: null },
  ],
  schedule: [
    { label: 'Pucallpa → Iquitos', value: 'Martes y viernes, 18:00' },
    { label: 'Iquitos → Pucallpa', value: 'Lunes y jueves, 17:00' },
  ],
  faq: [
    {
      question: '¿Cuánto equipaje puedo llevar?',
      answer: 'Hasta 20 kg por pasajero; el exceso se cobra por kilo.',
    },
  ],
  policies: [
    { title: 'Cambios y devoluciones', body: 'Puedes cambiar tu pasaje hasta 24 h antes de la salida.' },
  ],
  social: {
    website: null,
    facebook: 'https://facebook.com/navieraucayali',
    instagram: null,
    tiktok: null,
    youtube: null,
    x: null,
  },
  footerText: 'Naviera Ucayali S.A.C. · RUC 20601234507',
};
// Sin WHITE_LABEL: lo propio (tema, portada, FAQ) no se publica; sí servicios, sucursales y contacto.
const orienteSite: SiteConfig = {
  ...navieraSite,
  theme: { primary: '#0B3D91', accent: '#B42318', surface: 'light', radius: 'square', font: 'montserrat' },
  hero: { title: 'Este título no se publica sin el módulo', subtitle: '', imageAssetId: null },
  branches: [{ name: 'Tarapoto', address: 'Jr. Lamas 300', city: 'Tarapoto', phone: null, hours: null }],
};

async function publish(slug: string, config: SiteConfig) {
  expect(SiteConfigSchema.parse(config)).toEqual(config);
  expect(themeContrastProblems(config.theme)).toEqual([]);
  await withDb(async (db) => {
    const id = (await db.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [slug])).rows[0]?.id;
    await db.query(
      `INSERT INTO site_versions (tenant_id, version, status, live_slot, schema_version, config, updated_at,
                                  published_at, published_by_kind, published_by_id)
       VALUES ($1, 1, 'PUBLISHED', 'PUBLISHED', 1, $2::jsonb, now(), now(), 'MEMBERSHIP', gen_random_uuid())`,
      [id, JSON.stringify(config)],
    );
  });
}

async function staffPage(browser: Browser) {
  const ctx = await browser.newContext({ storageState: '.auth/staff.json', baseURL: hostUrl(E2E.adminHost) });
  return { ctx, page: await ctx.newPage() };
}

test('preparación: Naviera con WHITE_LABEL y tema propio; Oriente sin el módulo', async ({ browser }) => {
  const { ctx, page } = await staffPage(browser);
  await page.goto('/empresas');
  const naviera = await withDb(
    async (db) =>
      (await db.query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'naviera-ucayali'")).rows[0]?.id,
  );
  await apiPost(page, `/api/v1/platform/tenants/${naviera}/module-overrides`, {
    moduleCode: 'WHITE_LABEL',
    effect: 'GRANT',
    reason: 'Portal de marca propia (E2E)',
  });
  await ctx.close();
  await publish('naviera-ucayali', navieraSite);
  await publish('transportes-oriente', orienteSite);
});

test('Naviera: su tema (oscuro, Lora, verde lima) y todas sus secciones, accesible', async ({ page }) => {
  await page.goto(hostUrl(NAVIERA));
  await expect(page).toHaveTitle('Naviera Ucayali');
  await expect(page.getByRole('heading', { level: 1, name: 'Viaja por el Ucayali' })).toBeVisible();
  const root = page.locator('main').locator('..');
  expect(await root.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(16, 29, 43)');
  expect(await root.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Lora/i);
  const cta = page.getByRole('link', { name: 'Escríbenos por WhatsApp' });
  await expect(cta).toHaveAttribute('href', 'https://wa.me/51961234567');
  expect(await cta.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(197, 243, 107)');
  for (const h of ['Servicios', 'Horarios', 'Sucursales', 'Preguntas frecuentes', 'Políticas', 'Contacto']) {
    await expect(page.getByRole('heading', { level: 2, name: h })).toBeVisible();
  }
  await expect(page.getByRole('navigation', { name: 'Secciones' }).getByRole('link')).toHaveCount(6);
  await page.getByText('¿Cuánto equipaje puedo llevar?').click();
  await expect(page.getByText('Hasta 20 kg por pasajero')).toBeVisible();
  await expect(page.getByRole('link', { name: '+51 61 571234' }).first()).toHaveAttribute(
    'href',
    'tel:+5161571234',
  );
  await expect(page.getByRole('link', { name: 'reservas@naviera-ucayali.pe' })).toHaveAttribute(
    'href',
    'mailto:reservas@naviera-ucayali.pe',
  );
  await expect(page.getByText('Naviera Ucayali S.A.C. · RUC 20601234507')).toBeVisible();
  await expectAccessible(page, 'portal de Naviera (oscuro)');
  await page.screenshot({ path: 'capturas/portal-naviera.png', fullPage: true });
});

test('Oriente sin WHITE_LABEL: tema YEBO, portada con su nombre y solo lo básico', async ({ page }) => {
  await page.goto(hostUrl(ORIENTE));
  await expect(page).toHaveTitle('Transportes del Oriente');
  await expect(page.getByRole('heading', { level: 1, name: 'Transportes del Oriente' })).toBeVisible();
  await expect(page.getByText('Este título no se publica sin el módulo')).toHaveCount(0);
  const root = page.locator('main').locator('..');
  expect(await root.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await root.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Inter/i);
  for (const h of ['Servicios', 'Sucursales', 'Contacto']) {
    await expect(page.getByRole('heading', { level: 2, name: h })).toBeVisible();
  }
  for (const h of ['Horarios', 'Preguntas frecuentes', 'Políticas']) {
    await expect(page.getByRole('heading', { level: 2, name: h })).toHaveCount(0);
  }
  await expect(page.getByRole('heading', { level: 3, name: 'Tarapoto' })).toBeVisible();
  await expectAccessible(page, 'portal de Oriente (tema YEBO)');
  await page.screenshot({ path: 'capturas/portal-oriente.png', fullPage: true });
});

test('en móvil (390 px) los dos portales caben y siguen siendo accesibles', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  for (const host of [NAVIERA, ORIENTE]) {
    await page.goto(hostUrl(host));
    await expectNoHorizontalScroll(page, host);
    await expectAccessible(page, `portal ${host} en 390 px`);
  }
  await ctx.close();
});

/**
 * Criterio de la Fase 5 en el navegador: «Dos portales visualmente distintos sin duplicar apps». El mismo servidor
 * de apps/web responde a los dos hosts con los MISMOS archivos de la compilación (scripts y hojas de estilo con su
 * hash); lo que cambia es el documento publicado, y con él los tokens calculados y lo que se ve (capturas comparadas
 * píxel a píxel). La parte sin navegador está en la CI: phase5-criterion.int-spec (API) y theme.spec (apps/web).
 */
test('criterio de la Fase 5: la misma compilación sirve dos portales visualmente distintos', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const seen: { assets: string[]; tokens: Record<string, string>; shot: Buffer }[] = [];
  for (const host of [NAVIERA, ORIENTE]) {
    await page.goto(hostUrl(host));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const assets = await page.locator('script[src], link[rel="stylesheet"]').evaluateAll((els) =>
      els
        .map((el) => el.getAttribute('src') ?? el.getAttribute('href') ?? '')
        .filter((u) => u.includes('/_next/static/'))
        .sort(),
    );
    const tokens = await page
      .locator('[style*="--site-bg"]')
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return Object.fromEntries(
          ['--site-bg', '--site-text', '--site-primary', '--site-accent', '--site-radius'].map((k) => [
            k,
            s.getPropertyValue(k).trim(),
          ]),
        );
      });
    seen.push({ assets, tokens, shot: await page.screenshot() });
  }
  const [a, b] = seen;
  if (!a || !b) throw new Error('faltan los dos portales');

  // Sin duplicar apps: los mismos archivos de la misma compilación (con su hash de contenido).
  expect(a.assets.length).toBeGreaterThan(0);
  expect(b.assets).toEqual(a.assets);

  // Visualmente distintos: los tokens calculados…
  for (const k of Object.keys(a.tokens)) expect({ k, v: b.tokens[k] }).not.toEqual({ k, v: a.tokens[k] });
  // …y lo que se ve: más de la mitad de los píxeles de la primera pantalla cambian.
  const diff = await page.evaluate(
    async ([x, y]) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((ok, ko) => {
          const img = new Image();
          img.onload = () => ok(img);
          img.onerror = ko;
          img.src = `data:image/png;base64,${src}`;
        });
      const pixels = async (src: string) => {
        const img = await load(src);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const c = canvas.getContext('2d');
        if (!c) throw new Error('sin canvas');
        c.drawImage(img, 0, 0);
        return c.getImageData(0, 0, img.width, img.height).data;
      };
      const [p, q] = [await pixels(x), await pixels(y)];
      let changed = 0;
      for (let i = 0; i < p.length; i += 4) {
        const d = Math.abs(p[i]! - q[i]!) + Math.abs(p[i + 1]! - q[i + 1]!) + Math.abs(p[i + 2]! - q[i + 2]!);
        if (d > 30) changed++;
      }
      return changed / (p.length / 4);
    },
    [a.shot.toString('base64'), b.shot.toString('base64')] as const,
  );
  expect(diff).toBeGreaterThan(0.5);
  test.info().annotations.push({ type: 'píxeles distintos', description: `${Math.round(diff * 100)} %` });
  await ctx.close();
});

test('hub → login; host desconocido → 404; /estado se conserva', async ({ page }) => {
  await page.goto(hostUrl(E2E.hubHost));
  await expect(page).toHaveURL(/\/login$/);
  const unknown = await page.goto(hostUrl(`no-existe.${E2E.baseDomain}`));
  expect(unknown?.status()).toBe(404);
  await page.goto(hostUrl(NAVIERA, '/estado'));
  await expect(page.getByText('estado del sistema', { exact: false })).toBeVisible();
});
