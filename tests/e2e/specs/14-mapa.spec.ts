import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll } from '../support/a11y';
import { apiPost } from '../support/api';
import { CAPTURAS, capture } from '../support/capture';
import { withDb } from '../support/db';
import { E2E, hostUrl } from '../support/env';
import { followHttpRedirects } from '../support/tenant-login';

/**
 * Fase 7.6 · Mapa propio (F7-Q9, M-Q1 a M-Q7, maqueta 7.6), con el extracto pequeño de Pucallpa (M-Q3):
 *  - el mapa carga por rangos desde /mapa/ y la página no pide nada a otros dominios;
 *  - Ubicaciones: el mapa sigue a los campos y un clic en el mapa cambia la latitud y la longitud;
 *  - Rutas: dibujar un tramo con clics (quitar el último punto, terminar con el teclado), guardarlo y ver sus km;
 *  - sin el archivo del mapa, las pantallas lo dicen y todo sigue con la lista y los campos (M-Q7);
 *  - axe (WCAG 2.1 AA) con el mapa; modo oscuro y 390 px sin desplazamiento horizontal.
 */
test.describe.configure({ mode: 'serial' });

const SLUG = 'lanchas-yarina';
const HOST = `${SLUG}.${E2E.baseDomain}`;
const PASSWORD = 'lanchas-yarina-2026';

const dialog = (page: Page) => page.locator('dialog[open]');

async function tenantPost<T>(page: Page, path: string, body: unknown): Promise<T> {
  const csrf = (await page.context().cookies(hostUrl(HOST))).find(
    (c) => c.name === '__Host-yebo_csrf',
  )?.value;
  const res = await page.request.post(hostUrl(HOST, path), {
    data: body,
    headers: { 'X-CSRF-Token': csrf ?? '' },
  });
  if (!res.ok()) throw new Error(`${path} → ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function asStaff<T>(browser: Browser, run: (page: Page) => Promise<T>): Promise<T> {
  const staff = await browser.newContext({
    storageState: '.auth/staff.json',
    baseURL: hostUrl(E2E.adminHost),
  });
  try {
    const page = await staff.newPage();
    await page.goto('/empresas');
    return await run(page);
  } finally {
    await staff.close();
  }
}

/** Anota cada petición http(s) de la página: el mapa no debe pedir nada fuera del host de la empresa. */
function recordHosts(page: Page): Set<string> {
  const hosts = new Set<string>();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'http:' || u.protocol === 'https:') hosts.add(u.host);
  });
  return hosts;
}

/** Espera a que el mapa haya cargado su estilo y sus teselas (por rangos). */
async function mapReady(page: Page) {
  const map = page.locator('.yebo-map canvas');
  await expect(map).toBeVisible();
  await expect(page.getByText('Cargando el mapa…')).toHaveCount(0);
  await page.waitForFunction(() =>
    performance.getEntriesByType('resource').some((e) => e.name.includes('/mapa/peru.pmtiles')),
  );
  return map;
}

test('preparación: empresa fluvial con dos embarcaderos de Pucallpa y una ruta entre ellos', async ({
  browser,
}) => {
  const created = await asStaff(browser, async (page) => {
    const planVersionId = await withDb(
      async (db) =>
        (
          await db.query<{ id: string }>(
            `SELECT v.id FROM plan_versions v JOIN plans p ON p.id = v.plan_id
              WHERE p.code = 'basico-e2e' AND v.status = 'PUBLISHED' ORDER BY v.version LIMIT 1`,
          )
        ).rows[0]?.id,
    );
    return (await apiPost(page, '/api/v1/platform/tenants', {
      slug: SLUG,
      legalName: 'Lanchas Yarina S.A.C.',
      tradeName: 'Lanchas Yarina',
      taxIdType: 'RUC',
      taxId: '20605445566',
      planVersionId,
      services: [{ modality: 'RIVER', service: 'PASSENGER' }],
      firstAdminEmail: `gerencia@${SLUG}.pe`,
    })) as { firstAdminInvitation: { link: string } };
  });

  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(hostUrl(E2E.hubHost, `/invitacion#${created.firstAdminInvitation.link.split('#')[1]}`));
  await admin.getByLabel('Tu nombre completo').fill('Gerencia E2E');
  await admin.getByLabel('Crea una contraseña').fill(PASSWORD);
  await admin.getByLabel('Repite la contraseña').fill(PASSWORD);
  await admin.getByRole('button', { name: 'Crear mi cuenta y aceptar' }).click();
  await expect(admin.getByRole('heading', { name: 'Ya formas parte de Lanchas Yarina' })).toBeVisible();
  await followHttpRedirects(admin);
  await admin.goto(hostUrl(HOST, '/panel'));
  await admin.getByRole('link', { name: 'Iniciar sesión' }).click();
  await expect(admin).toHaveURL(/\/panel\//);

  const ids: string[] = [];
  for (const place of [
    { name: 'Puerto Pucallpa', kind: 'PORT', lat: -8.3791, lng: -74.5539 },
    { name: 'Embarcadero Yarinacocha', kind: 'LANDING', lat: -8.353, lng: -74.588 },
  ]) {
    ids.push(
      (await tenantPost<{ id: string }>(admin, '/api/v1/locations', { ...place, ubigeo: null, region: null }))
        .id,
    );
  }
  await tenantPost(admin, '/api/v1/routes', {
    code: 'PCL-YAR',
    name: 'Pucallpa – Yarinacocha',
    modality: 'RIVER',
    stops: [
      {
        locationId: ids[0],
        offsetMinutes: 0,
        dwellMinutes: 0,
        allowsBoarding: true,
        allowsAlighting: false,
        pathToNext: null,
      },
      {
        locationId: ids[1],
        offsetMinutes: 40,
        dwellMinutes: 0,
        allowsBoarding: false,
        allowsAlighting: true,
        pathToNext: null,
      },
    ],
  });
  await ctx.storageState({ path: '.auth/yarina.json' });
  await ctx.close();
});

test.describe('con la sesión de la empresa', () => {
  test.use({ storageState: '.auth/yarina.json', viewport: { width: 1440, height: 900 } });

  test('Ubicaciones: el mapa sigue a los campos y un clic elige la posición', async ({ page }) => {
    const hosts = recordHosts(page);
    await page.goto(hostUrl(HOST, '/panel/ubicaciones'));
    await page.getByRole('button', { name: 'Nueva ubicación' }).click();
    const d = dialog(page);
    await d.getByLabel('Nombre').fill('Muelle de prueba');
    await d.getByLabel('Latitud (opcional)').fill('-8.3791');
    await d.getByLabel('Longitud (opcional)').fill('-74.5539');
    const map = await mapReady(page);
    await expect(map).toHaveAttribute('aria-label', /latitud -8\.3791, longitud -74\.5539/);
    await expect(d.getByRole('img', { name: 'Posición de la ubicación' })).toBeVisible();
    await expect(d.getByRole('link', { name: 'OpenStreetMap' })).toBeVisible();
    await expectAccessible(page, 'diálogo de ubicación con mapa');
    if (CAPTURAS) await capture(page, 'ubicacion-mapa');

    // Un clic al noreste del centro: la posición cambia, cerca de la anterior.
    const box = (await map.boundingBox())!;
    await map.click({ position: { x: box.width * 0.75, y: box.height * 0.3 } });
    const lat = Number(await d.getByLabel('Latitud (opcional)').inputValue());
    const lng = Number(await d.getByLabel('Longitud (opcional)').inputValue());
    expect(lat).toBeGreaterThan(-8.3791);
    expect(lng).toBeGreaterThan(-74.5539);
    expect(Math.abs(lat + 8.3791)).toBeLessThan(0.1);
    expect(Math.abs(lng + 74.5539)).toBeLessThan(0.1);
    await d.getByRole('button', { name: 'Crear ubicación' }).click();
    await expect(page.getByText('Ubicación Muelle de prueba guardada')).toBeAttached();

    expect([...hosts]).toEqual([`${HOST}:${E2E.platformPort}`]);
  });

  test('Rutas: dibujar un tramo con clics, terminar con el teclado, guardar y ver sus km', async ({
    page,
  }) => {
    const hosts = recordHosts(page);
    await page.goto(hostUrl(HOST, '/panel/rutas'));
    await expect(
      page.getByRole('heading', { level: 2, name: 'PCL-YAR · Pucallpa – Yarinacocha' }),
    ).toBeVisible();
    const map = await mapReady(page);
    await expect(map).toHaveAttribute(
      'aria-label',
      'Mapa de la ruta: 2 de 2 paradas en el mapa; tramo 1, Puerto Pucallpa → Embarcadero Yarinacocha, en línea recta.',
    );
    const legs = page.getByRole('list', { name: 'Tramos de la ruta' });
    await expect(legs).toContainText(/km en línea recta · sin traza/);
    await expectAccessible(page, 'ruta con mapa');

    await legs.getByRole('button', { name: 'Dibujar en el mapa' }).click();
    await expect(
      page.getByText(/^Dibujando el tramo 1: Puerto Pucallpa → Embarcadero Yarinacocha\./),
    ).toBeVisible();
    await expect(page.getByText('0 puntos intermedios', { exact: false })).toBeVisible();
    const box = (await map.boundingBox())!;
    await map.click({ position: { x: box.width * 0.5, y: box.height * 0.2 } });
    await expect(page.getByText(/^1 punto intermedio · /)).toBeVisible();
    await map.click({ position: { x: box.width * 0.62, y: box.height * 0.22 } });
    await expect(page.getByText(/^2 puntos intermedios · /)).toBeVisible();
    await page.getByRole('button', { name: 'Quitar el último punto' }).click();
    await expect(page.getByText(/^1 punto intermedio · /)).toBeVisible();
    await map.click({ position: { x: box.width * 0.4, y: box.height * 0.25 } });
    await expect(page.getByText(/^2 puntos intermedios · /)).toBeVisible();
    await expectAccessible(page, 'dibujando un tramo');
    if (CAPTURAS) await capture(page, 'rutas-dibujo');

    // Terminar con el teclado.
    await page.getByRole('button', { name: 'Terminar' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText(/^Traza del tramo 1 dibujada: [\d.]+ km\. Se guarda con la ruta\./),
    ).toBeAttached();
    await expect(legs).toContainText(/km por la traza/);
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText('Ruta PCL-YAR guardada')).toBeAttached();

    // Guardada: la traza tiene las dos paradas como extremos y los dos puntos dibujados.
    const path = await withDb(
      async (db) =>
        (
          await db.query<{ path: [number, number][] }>(
            `SELECT s.path_to_next AS path FROM route_stops s JOIN routes r ON r.id = s.route_id
              WHERE r.code = 'PCL-YAR' AND s.seq = 0`,
          )
        ).rows[0]?.path,
    );
    expect(path).toHaveLength(4);
    expect(path![0]).toEqual([-74.5539, -8.3791]);
    expect(path![3]).toEqual([-74.588, -8.353]);

    await page.reload();
    await expect(page.getByRole('list', { name: 'Tramos de la ruta' })).toContainText(/km por la traza/);
    await expect(page.getByRole('button', { name: 'Corregir en el mapa' })).toBeVisible();
    await expect(page.locator('.yebo-map canvas')).toHaveAttribute('aria-label', /con traza\.$/);
    expect([...hosts]).toEqual([`${HOST}:${E2E.platformPort}`]);
  });

  test('sin el archivo del mapa: lo dicen y todo sigue con la lista y los campos', async ({ page }) => {
    await page.route('**/mapa/peru.pmtiles', (r) => r.fulfill({ status: 404 }));
    await page.goto(hostUrl(HOST, '/panel/rutas'));
    await expect(
      page.getByRole('heading', { level: 2, name: 'PCL-YAR · Pucallpa – Yarinacocha' }),
    ).toBeVisible();
    await expect(page.getByText(/^El mapa no está instalado en este servidor\./)).toBeVisible();
    await expect(page.getByRole('button', { name: /en el mapa$/ })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Tramos de la ruta' })).toContainText(/km por la traza/);
    await expectAccessible(page, 'rutas sin mapa');

    await page.goto(hostUrl(HOST, '/panel/ubicaciones'));
    await page.getByRole('button', { name: 'Nueva ubicación' }).click();
    await expect(dialog(page).getByText(/^El mapa no está instalado en este servidor\./)).toBeVisible();
    await expect(dialog(page).getByLabel('Latitud (opcional)')).toBeEditable();
  });

  for (const scheme of ['dark', 'light'] as const) {
    test(`${scheme === 'dark' ? 'modo oscuro' : 'móvil (390 px)'}: Rutas y Ubicaciones con mapa`, async ({
      page,
    }) => {
      if (scheme === 'dark') await page.emulateMedia({ colorScheme: 'dark' });
      else await page.setViewportSize({ width: 390, height: 844 });
      const label = scheme === 'dark' ? 'oscuro' : 'móvil';
      await page.goto(hostUrl(HOST, '/panel/rutas'));
      await mapReady(page);
      if (scheme === 'light') await expectNoHorizontalScroll(page, `Rutas en ${label}`);
      await expectAccessible(page, `Rutas con mapa en ${label}`);
      await page.goto(hostUrl(HOST, '/panel/ubicaciones'));
      await page.getByRole('button', { name: 'Nueva ubicación' }).click();
      await mapReady(page);
      if (scheme === 'light') await expectNoHorizontalScroll(page, `Ubicación en ${label}`);
      await expectAccessible(page, `Ubicación con mapa en ${label}`);
    });
  }
});
