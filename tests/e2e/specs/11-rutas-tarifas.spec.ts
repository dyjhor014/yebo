import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll } from '../support/a11y';
import { apiPost } from '../support/api';
import { CAPTURAS, capture } from '../support/capture';
import { withDb } from '../support/db';
import { E2E, hostUrl } from '../support/env';
import { followHttpRedirects } from '../support/tenant-login';

/**
 * Fase 7.5a · Rutas y Tarifas en el panel de la empresa (APIs de la 7.1 y la 7.2, maqueta 7.5 aprobada):
 *  - el carril agrupa «Operación» y «Configuración»;
 *  - Rutas: nueva ruta con sus paradas, tiempos escritos a mano («12 h», «2 d 12 h»), errores junto a la fila, mover
 *    con Alt + flechas, traza importada de un GPX, aviso fluvial que no impide guardar, archivar y restaurar;
 *  - Tarifas: clase agregada a mano, precio de una celda, cambio de precio programado, anularlo, cambiar el fin y
 *    «Poner precios» en lote.
 * axe (WCAG 2.1 AA) en cada pantalla y diálogo; modo oscuro y 390 px sin desplazamiento horizontal.
 */
test.describe.configure({ mode: 'serial' });

const SLUG = 'rutas-del-ucayali';
const HOST = `${SLUG}.${E2E.baseDomain}`;
const ADMIN_EMAIL = `gerencia@${SLUG}.pe`;
const PASSWORD = 'rutas-del-ucayali-2026';

const dialog = (page: Page) => page.locator('dialog[open]');
const nav = (page: Page) => page.getByRole('navigation', { name: 'Secciones del panel' });
const lima = (offset = 0) => {
  const d = new Date(
    `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date())}T00:00:00Z`,
  );
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

/** Traza Pucallpa → Contamana por el Ucayali (GPX con 4 puntos). */
const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="e2e"><trk><name>Ucayali</name><trkseg>
<trkpt lat="-8.3791" lon="-74.5539"></trkpt><trkpt lat="-8.0" lon="-74.7"></trkpt>
<trkpt lat="-7.6" lon="-74.9"></trkpt><trkpt lat="-7.3352" lon="-75.0094"></trkpt>
</trkseg></trk></gpx>`;

/** POST a la API de la empresa con el CSRF de SU cookie (el navegador también tiene la del hub). */
async function tenantPost(page: Page, path: string, body: unknown) {
  const csrf = (await page.context().cookies(hostUrl(HOST))).find(
    (c) => c.name === '__Host-yebo_csrf',
  )?.value;
  const res = await page.request.post(hostUrl(HOST, path), {
    data: body,
    headers: { 'X-CSRF-Token': csrf ?? '' },
  });
  if (!res.ok()) throw new Error(`${path} → ${res.status()}: ${await res.text()}`);
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

test('preparación: empresa fluvial, su administradora y sus ubicaciones', async ({ browser }) => {
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
      legalName: 'Rutas del Ucayali S.A.C.',
      tradeName: 'Rutas del Ucayali',
      taxIdType: 'RUC',
      taxId: '20605112233',
      planVersionId,
      services: [{ modality: 'RIVER', service: 'PASSENGER' }],
      firstAdminEmail: ADMIN_EMAIL,
    })) as { firstAdminInvitation: { link: string } };
  });

  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(hostUrl(E2E.hubHost, `/invitacion#${created.firstAdminInvitation.link.split('#')[1]}`));
  await admin.getByLabel('Tu nombre completo').fill('Gerencia E2E');
  await admin.getByLabel('Crea una contraseña').fill(PASSWORD);
  await admin.getByLabel('Repite la contraseña').fill(PASSWORD);
  await admin.getByRole('button', { name: 'Crear mi cuenta y aceptar' }).click();
  await expect(admin.getByRole('heading', { name: 'Ya formas parte de Rutas del Ucayali' })).toBeVisible();

  await followHttpRedirects(admin);
  await admin.goto(hostUrl(HOST, '/panel'));
  await admin.getByRole('link', { name: 'Iniciar sesión' }).click();
  await expect(admin).toHaveURL(/\/panel\//);
  for (const place of [
    { name: 'Pucallpa', kind: 'PORT', lat: -8.3791, lng: -74.5539 },
    { name: 'Contamana', kind: 'PORT', lat: -7.3352, lng: -75.0094 },
    { name: 'Iquitos', kind: 'CITY', lat: -3.7491, lng: -73.2472 },
  ]) {
    await tenantPost(admin, '/api/v1/locations', { ...place, ubigeo: null, region: null });
  }
  await ctx.storageState({ path: '.auth/rutas.json' });
  await ctx.close();
});

test.describe('con la sesión de la empresa', () => {
  test.use({ storageState: '.auth/rutas.json', viewport: { width: 1440, height: 900 } });

  test('carril: «Operación» con Rutas y Tarifas, y «Configuración»', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/rutas'));
    await expect(nav(page).getByText('Operación')).toBeVisible();
    await expect(nav(page).getByText('Configuración')).toBeVisible();
    for (const name of ['Rutas', 'Tarifas', 'Ubicaciones', 'Flota', 'Planos'])
      await expect(nav(page).getByRole('link', { name })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Rutas' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText(/^Aún no hay rutas/)).toBeVisible();
    await expectAccessible(page, 'rutas vacía');
  });

  test('Rutas: nueva ruta con paradas, errores junto a la fila, mover con el teclado, traza GPX y aviso fluvial', async ({
    page,
  }) => {
    await page.goto(hostUrl(HOST, '/panel/rutas'));
    await page.getByRole('button', { name: 'Nueva ruta' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Nueva ruta' })).toBeVisible();
    await page.getByLabel('Código').fill('pcl-iqt');
    await expect(page.getByLabel('Código')).toHaveValue('PCL-IQT');
    await page.getByLabel('Nombre', { exact: true }).fill('Pucallpa – Iquitos');
    await page.getByLabel('Parada 1', { exact: true }).selectOption({ label: 'Pucallpa · Puerto' });
    await page.getByLabel('Parada 2', { exact: true }).selectOption({ label: 'Contamana · Puerto' });
    await page.getByRole('button', { name: 'Agregar parada' }).click();
    await page.getByLabel('Parada 3', { exact: true }).selectOption({ label: 'Iquitos · Ciudad' });
    await page.getByLabel('Contamana: tiempo desde la salida').fill('mañana');
    await page.getByLabel('Iquitos: tiempo desde la salida').fill('2 d 12 h');
    await page.getByRole('button', { name: 'Crear ruta' }).click();
    await expect(page.getByText('Revisa los campos marcados.')).toBeVisible();
    await expect(page.getByText('Escribe un tiempo, p. ej. 12 h o 1 d 6 h')).toBeVisible();
    await expectAccessible(page, 'nueva ruta con un error');

    await page.getByLabel('Contamana: tiempo desde la salida').fill('12 h');
    await page.getByLabel('Contamana: tiempo detenido').fill('1 h');
    await expect(page.getByText('día 1 · +12 h')).toBeVisible();
    await expect(page.getByText('día 3 · +2 d 12 h')).toBeVisible();

    // Alt + flechas con el foco en la fila: Contamana baja al tercer lugar y vuelve.
    await page.getByLabel('Parada 2', { exact: true }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.getByText('Contamana ahora es la parada 3 de 3')).toBeAttached();
    await expect(page.getByLabel('Parada 3', { exact: true })).toHaveValue(/.+/);
    await expect(page.getByLabel('Parada 3', { exact: true }).locator('option:checked')).toHaveText(
      'Contamana · Puerto',
    );
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByLabel('Parada 2', { exact: true }).locator('option:checked')).toHaveText(
      'Contamana · Puerto',
    );

    // Traza del primer tramo desde un GPX: los km pasan de línea recta a la traza.
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: 'ucayali.gpx',
        mimeType: 'application/gpx+xml',
        buffer: Buffer.from(GPX),
      });
    await expect(page.getByText(/^Traza importada \(GPX\): 4 puntos/)).toBeAttached();
    await expect(page.getByText('126.57 km', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Quitar traza' })).toBeVisible();

    await page.getByRole('button', { name: 'Crear ruta' }).click();
    await expect(page.getByText('Ruta PCL-IQT creada')).toBeAttached();
    await expect(page.getByRole('heading', { level: 2, name: 'PCL-IQT · Pucallpa – Iquitos' })).toBeVisible();
    await expect(page.getByText('Iquitos no es puerto ni embarcadero.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Tramos de la ruta' })).toContainText('Iquitos');
    await expectAccessible(page, 'ruta guardada');
    if (CAPTURAS) await capture(page, 'rutas');

    // Archivar deja la ruta de solo lectura; restaurar la devuelve.
    await page.getByRole('button', { name: 'Archivar' }).click();
    await expect(page.getByText(/^La ruta está archivada/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guardar cambios' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Restaurar' }).click();
    await expect(page.getByRole('button', { name: 'Guardar cambios' })).toBeVisible();
  });

  test('Tarifas: clase a mano, precio, cambio programado, anular, cambiar el fin y precios en lote', async ({
    page,
  }) => {
    await page.goto(hostUrl(HOST, '/panel/tarifas'));
    await expect(page.getByRole('heading', { level: 1, name: 'Tarifas' })).toBeVisible();
    await expect(page.getByText(/^Aún no hay clases de precio/)).toBeVisible();
    await page.getByLabel('Nueva clase de precio').fill('general');
    await page.getByRole('button', { name: 'Agregar clase' }).click();
    await expect(page.getByText('3 sin precio')).toBeVisible();
    await expectAccessible(page, 'matriz sin precios');

    await page.getByRole('button', { name: 'Pucallpa a Iquitos, General: sin precio. Poner precio' }).click();
    await expect(page.getByRole('heading', { name: 'Pucallpa → Iquitos · General' })).toBeVisible();
    await page.getByLabel('Precio (S/)').fill('120');
    await page.getByRole('button', { name: 'Guardar el precio' }).click();
    await expect(page.getByText(/^Precio S\/ 120.00 desde el/)).toBeAttached();
    const cell = page.getByRole('button', { name: /^S\/ 120.00/ });
    await expect(cell).toBeVisible();

    // Cambio de precio desde mañana: la celda lo anuncia y el historial muestra vigente y programada.
    await page.getByLabel('Precio (S/)').fill('130,50');
    await page.getByLabel('Desde').fill(lima(1));
    await page.getByRole('button', { name: 'Guardar el precio' }).click();
    await expect(page.getByText(/el de S\/ 120.00 termina ese día/)).toBeAttached();
    await expect(page.getByText(/cambia a S\/ 130.50 el/)).toBeVisible();
    await expect(page.getByText('Vigente', { exact: true })).toBeVisible();
    await expect(page.getByText('Programada', { exact: true })).toBeVisible();
    await expectAccessible(page, 'celda con historial');
    if (CAPTURAS) await capture(page, 'tarifas');

    await page.getByRole('button', { name: 'Anular' }).click();
    await expect(page.getByText('Tarifa de S/ 130.50 anulada')).toBeAttached();
    await expect(page.getByText('Anulada', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Cambiar el fin' }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Cambiar el fin de S/ 120.00' })).toBeVisible();
    await d.getByLabel('Termina el').fill(lima(30));
    await expectAccessible(page, 'diálogo cambiar el fin');
    await d.getByRole('button', { name: 'Guardar el fin' }).click();
    await expect(d).toHaveCount(0);
    await expect(page.getByText(/^La tarifa de S\/ 120.00 ahora termina el/)).toBeAttached();

    // Precios en lote: se llena uno de los que faltan.
    await page.getByRole('button', { name: 'Poner precios' }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Poner precios' })).toBeVisible();
    await dialog(page).getByLabel('Pucallpa → Contamana · General').fill('35,50');
    await expect(dialog(page).getByText('1 de 2 con precio')).toBeVisible();
    await expectAccessible(page, 'diálogo poner precios');
    await dialog(page).getByRole('button', { name: 'Guardar precios' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText('1 precio guardado')).toBeAttached();
    await expect(page.getByText('1 sin precio')).toBeVisible();
  });

  for (const scheme of ['dark', 'light'] as const) {
    test(`${scheme === 'dark' ? 'modo oscuro' : 'móvil (390 px)'}: Rutas y Tarifas`, async ({ page }) => {
      if (scheme === 'dark') await page.emulateMedia({ colorScheme: 'dark' });
      else await page.setViewportSize({ width: 390, height: 844 });
      const label = scheme === 'dark' ? 'oscuro' : 'móvil';
      await page.goto(hostUrl(HOST, '/panel/rutas'));
      await expect(page.getByRole('region', { name: 'Paradas de la ruta' })).toBeVisible();
      if (scheme === 'light') await expectNoHorizontalScroll(page, `Rutas en ${label}`);
      await expectAccessible(page, `Rutas en ${label}`);
      await page.goto(hostUrl(HOST, '/panel/tarifas'));
      await expect(page.getByRole('region', { name: 'Tabla de precios' })).toBeVisible();
      if (scheme === 'light') await expectNoHorizontalScroll(page, `Tarifas en ${label}`);
      await expectAccessible(page, `Tarifas en ${label}`);
      if (CAPTURAS) await capture(page, `tarifas-${label}`);
    });
  }
});
