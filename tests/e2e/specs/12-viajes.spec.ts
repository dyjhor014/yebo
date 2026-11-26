import { expect, test, type Browser, type Page } from '@playwright/test';
import { busTemplate } from '@yebo/contracts';
import { expectAccessible, expectNoHorizontalScroll } from '../support/a11y';
import { apiPost } from '../support/api';
import { CAPTURAS, capture } from '../support/capture';
import { withDb } from '../support/db';
import { E2E, hostUrl } from '../support/env';
import { followHttpRedirects } from '../support/tenant-login';

/**
 * Fase 7.5b · Programaciones, Viajes y la ficha del viaje en el panel (APIs de la 7.3 y la 7.4, maqueta 7.5):
 *  - programación diaria con unidad por defecto y «Generar viajes» (resultado con sus conteos);
 *  - agenda semanal, viaje puntual sin unidad;
 *  - ficha: abrir a la venta, disponibilidad por tramo, bloqueo de asientos y de un cupo, error de ocupado, volver a
 *    planificado bloqueado por la ocupación, liberar, volver y cancelar con motivo;
 *  - axe (WCAG 2.1 AA) en cada pantalla y diálogo; modo oscuro y 390 px sin desplazamiento horizontal.
 */
test.describe.configure({ mode: 'serial' });

const SLUG = 'viajes-de-la-selva';
const HOST = `${SLUG}.${E2E.baseDomain}`;
const PASSWORD = 'viajes-de-la-selva-2026';

const dialog = (page: Page) => page.locator('dialog[open]');
const lima = (offset = 0) => {
  const d = new Date(
    `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date())}T00:00:00Z`,
  );
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const monday = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/** Llamada a la API de la empresa con el CSRF de SU cookie (el navegador también tiene la del hub). */
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

test('preparación: empresa terrestre, ruta, bus con plano y su administradora', async ({ browser }) => {
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
      legalName: 'Viajes de la Selva S.A.C.',
      tradeName: 'Viajes de la Selva',
      taxIdType: 'RUC',
      taxId: '20605223344',
      planVersionId,
      services: [{ modality: 'LAND', service: 'PASSENGER' }],
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
  await expect(admin.getByRole('heading', { name: 'Ya formas parte de Viajes de la Selva' })).toBeVisible();
  await followHttpRedirects(admin);
  await admin.goto(hostUrl(HOST, '/panel'));
  await admin.getByRole('link', { name: 'Iniciar sesión' }).click();
  await expect(admin).toHaveURL(/\/panel\//);

  const ids: string[] = [];
  for (const place of [
    { name: 'Pucallpa', kind: 'TERMINAL', lat: -8.3791, lng: -74.5539 },
    { name: 'Aguaytía', kind: 'TERMINAL', lat: -9.0367, lng: -75.5089 },
    { name: 'Tingo María', kind: 'TERMINAL', lat: -9.2953, lng: -75.9975 },
  ]) {
    ids.push(
      (await tenantPost<{ id: string }>(admin, '/api/v1/locations', { ...place, ubigeo: null, region: null }))
        .id,
    );
  }
  const stop = (i: number, offsetMinutes: number, over: object = {}) => ({
    locationId: ids[i],
    offsetMinutes,
    dwellMinutes: 0,
    allowsBoarding: true,
    allowsAlighting: true,
    pathToNext: null,
    ...over,
  });
  await tenantPost(admin, '/api/v1/routes', {
    code: 'PCL-TGM',
    name: 'Pucallpa – Tingo María',
    modality: 'LAND',
    stops: [
      stop(0, 0, { allowsAlighting: false }),
      stop(1, 180, { dwellMinutes: 20 }),
      stop(2, 360, { allowsBoarding: false }),
    ],
  });
  const layout = await tenantPost<{ layoutId: string }>(admin, '/api/v1/layouts', {
    name: 'Bus 40',
    modality: 'LAND',
    vehicleTypeId: null,
    document: busTemplate(),
  });
  await tenantPost(admin, `/api/v1/layouts/${layout.layoutId}/publish`, {});
  const type = await tenantPost<{ id: string }>(admin, '/api/v1/vehicle-types', {
    name: 'Bus interprovincial',
    modality: 'LAND',
    catalogCode: 'BUS',
  });
  const bus = await tenantPost<{ id: string }>(admin, '/api/v1/vehicles', {
    code: 'BUS-01',
    name: 'Bus Selva',
    vehicleTypeId: type.id,
    registration: 'ABC-123',
    status: 'ACTIVE',
    ownership: 'OWN',
    nominalCapacity: { passengers: null, weightKg: null, volumeM3: null },
    features: [],
  });
  await tenantPost(admin, `/api/v1/vehicles/${bus.id}/layout-assignments`, {
    layoutId: layout.layoutId,
    version: 1,
    validFrom: lima(0),
    validTo: null,
  });
  await ctx.storageState({ path: '.auth/selva.json' });
  await ctx.close();
});

test.describe('con la sesión de la empresa', () => {
  test.use({ storageState: '.auth/selva.json', viewport: { width: 1440, height: 900 } });

  test('Programaciones: diaria con el bus, «Generar viajes» y su resultado', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/programaciones'));
    await expect(page.getByText(/^Aún no hay programaciones/)).toBeVisible();
    await expectAccessible(page, 'programaciones vacía');
    await page.getByRole('button', { name: 'Nueva programación' }).click();
    await page.getByLabel('Código').fill('pcl-diario');
    await page.getByRole('button', { name: 'Todos los días' }).click();
    await page.getByLabel('Hora de salida').fill('07:00');
    await page.getByLabel('Desde').fill(lima(1));
    await page.getByLabel('Unidad (opcional)').selectOption({ label: 'BUS-01 · Bus Selva' });
    await page.getByLabel('Fecha', { exact: true }).fill(lima(5));
    await page.getByRole('button', { name: 'Agregar fecha' }).click();
    await page.getByRole('button', { name: 'Crear programación' }).click();
    await expect(page.getByText('Programación PCL-DIARIO creada')).toBeAttached();
    await expect(page.getByRole('heading', { name: 'PCL-DIARIO · Pucallpa – Tingo María' })).toBeVisible();

    await page.getByRole('button', { name: 'Generar viajes' }).click();
    const result = page.getByRole('region', { name: 'Resultado de generar' });
    await expect(page.getByRole('heading', { name: 'Resultado de generar' })).toBeVisible();
    // Del día siguiente al horizonte (60 días desde hoy): 59 fechas menos la excluida.
    await expect(page.getByText('Creados', { exact: true }).locator('..')).toContainText('58');
    await expect(page.getByText('Creados sin unidad', { exact: true }).locator('..')).toContainText('0');
    void result;
    await expectAccessible(page, 'programación generada');
    if (CAPTURAS) await capture(page, 'programaciones');
    // Otra vez: no crea nada.
    await page.getByRole('button', { name: 'Generar viajes' }).click();
    await expect(page.getByText('Ya existían', { exact: true }).locator('..')).toContainText('58');
  });

  test('Viajes: agenda de la semana y viaje puntual sin unidad', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/viajes'));
    await expect(page.getByRole('heading', { level: 1, name: 'Viajes' })).toBeVisible();
    if (monday(lima(1)) !== monday(lima(0)))
      await page.getByRole('button', { name: 'Semana siguiente' }).click();
    await expect(page.getByRole('link', { name: /07:00 Pucallpa → Tingo María/ }).first()).toBeVisible();
    await expectAccessible(page, 'agenda de viajes');
    if (CAPTURAS) await capture(page, 'viajes');

    await page.getByRole('button', { name: 'Nuevo viaje' }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Nuevo viaje' })).toBeVisible();
    await d.getByLabel('Fecha de salida').fill(lima(2));
    await d.getByLabel('Hora de salida').fill('15:30');
    await expectAccessible(page, 'diálogo nuevo viaje');
    await d.getByRole('button', { name: 'Crear viaje' }).click();
    await expect(page).toHaveURL(/\/panel\/viajes\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Planificado', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Sin unidad\. Asígnale una/)).toBeVisible();
    await expect(page.getByText(/^Sin plano todavía/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar viaje' }).click();
    await dialog(page).getByLabel('Motivo').fill('Prueba de cancelación');
    await dialog(page).getByRole('button', { name: 'Cancelar el viaje' }).click();
    await expect(page.getByText('Cancelado', { exact: true })).toBeVisible();
    await expect(page.getByText(/cancelado: Prueba de cancelación/)).toBeVisible();
  });

  test('ficha: abrir a la venta, bloquear, ocupado, no vuelve a planificado con ocupación, liberar y volver', async ({
    page,
  }) => {
    await page.goto(hostUrl(HOST, '/panel/viajes'));
    if (monday(lima(1)) !== monday(lima(0)))
      await page.getByRole('button', { name: 'Semana siguiente' }).click();
    await page
      .getByRole('link', { name: /07:00 Pucallpa → Tingo María/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/panel\/viajes\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Planificado', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Abrir a la venta' }).click();
    await expect(page.getByText('A la venta', { exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Tramo' }).getByRole('button')).toHaveCount(2);
    // Teclado: Tab hasta el segundo tramo y la barra espaciadora.
    const tramo2 = page.getByRole('group', { name: 'Tramo' }).getByRole('button').nth(1);
    await page.getByRole('group', { name: 'Tramo' }).getByRole('button').first().focus();
    await page.keyboard.press('Tab');
    await expect(tramo2).toBeFocused();
    await page.keyboard.press('Space');
    await expect(tramo2).toHaveAttribute('aria-pressed', 'true');
    await expectAccessible(page, 'ficha del viaje a la venta');

    await page.getByRole('button', { name: 'Nuevo bloqueo' }).click();
    let d = dialog(page);
    await d.getByLabel('Lugares (opcional)').fill('1a, 1B');
    await d.getByLabel('Aforo de la unidad · personas').fill('2');
    await d.getByLabel('Nota (opcional)').fill('Tripulación de relevo');
    await expectAccessible(page, 'diálogo nuevo bloqueo');
    await d.getByRole('button', { name: 'Bloquear' }).click();
    await expect(d).toHaveCount(0);
    await expect(page.getByText(/^Tripulación · 1A, 1B · 2 en Aforo de la unidad/)).toBeVisible();
    await expect(page.getByRole('list', { name: /Lugares de la zona SALON/ }).getByText('1A')).toContainText(
      'ocupado',
    );
    // Orden natural de los lugares: 1A antes que 10A.
    await expect(
      page
        .getByRole('list', { name: /Lugares de la zona SALON/ })
        .getByRole('listitem')
        .first(),
    ).toContainText('1A');
    await expect(page.getByRole('row', { name: /Aforo de la unidad/ })).toContainText('38 de 40');

    // Lo ocupado: el mismo asiento otra vez, con el tramo exacto.
    await page.getByRole('button', { name: 'Nuevo bloqueo' }).click();
    d = dialog(page);
    await d.getByLabel('Lugares (opcional)').fill('1B');
    await d.getByRole('button', { name: 'Bloquear' }).click();
    await expect(d.getByText('Ocupado entre Pucallpa y Tingo María: 1B')).toBeVisible();
    await d.getByRole('button', { name: 'Cancelar' }).click();

    await expect(page.getByText(/^Tiene 1 bloqueo activo/)).toBeVisible();
    await page.getByRole('button', { name: 'Volver a planificado' }).click();
    await expect(
      page.getByText('El viaje tiene ocupación (bloqueos o ventas): libérala antes'),
    ).toBeVisible();
    await page.getByRole('button', { name: /^Liberar el bloqueo de tripulación/ }).click();
    await expect(page.getByText('Liberado', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Volver a planificado' }).click();
    await expect(page.getByText('Planificado', { exact: true })).toBeVisible();
    if (CAPTURAS) await capture(page, 'viaje-ficha');
  });

  for (const scheme of ['dark', 'light'] as const) {
    test(`${scheme === 'dark' ? 'modo oscuro' : 'móvil (390 px)'}: Viajes, ficha y Programaciones`, async ({
      page,
    }) => {
      if (scheme === 'dark') await page.emulateMedia({ colorScheme: 'dark' });
      else await page.setViewportSize({ width: 390, height: 844 });
      const label = scheme === 'dark' ? 'oscuro' : 'móvil';
      await page.goto(hostUrl(HOST, '/panel/viajes'));
      if (monday(lima(1)) !== monday(lima(0)))
        await page.getByRole('button', { name: 'Semana siguiente' }).click();
      const link = page.getByRole('link', { name: /07:00 Pucallpa → Tingo María/ }).first();
      await expect(link).toBeVisible();
      if (scheme === 'light') await expectNoHorizontalScroll(page, `Viajes en ${label}`);
      await expectAccessible(page, `Viajes en ${label}`);
      await link.click();
      await expect(page.getByRole('heading', { name: 'Disponibilidad por tramo' })).toBeVisible();
      if (scheme === 'light') await expectNoHorizontalScroll(page, `ficha en ${label}`);
      await expectAccessible(page, `ficha en ${label}`);
      await page.goto(hostUrl(HOST, '/panel/programaciones'));
      await expect(page.getByRole('heading', { name: 'PCL-DIARIO · Pucallpa – Tingo María' })).toBeVisible();
      if (scheme === 'light') await expectNoHorizontalScroll(page, `Programaciones en ${label}`);
      await expectAccessible(page, `Programaciones en ${label}`);
    });
  }
});
