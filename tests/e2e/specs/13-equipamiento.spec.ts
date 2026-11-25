import { expect, test, type Browser, type Page } from '@playwright/test';
import { fastBoatTemplate } from '@yebo/contracts';
import { expectAccessible, expectNoHorizontalScroll } from '../support/a11y';
import { apiPost } from '../support/api';
import { CAPTURAS, capture } from '../support/capture';
import { withDb } from '../support/db';
import { E2E, hostUrl } from '../support/env';
import { followHttpRedirects } from '../support/tenant-login';

/**
 * Fase 7.5c · Equipamiento de la unidad e inspección en el celular (la 7.E2; API de la 7.E1, maqueta 7.5):
 *  - Flota: sin equipamiento es válido; agregar desde el catálogo (solo lo de la modalidad, con la referencia
 *    orientativa), elemento propio guardado en el catálogo de la empresa, editar con vencimiento y eliminar;
 *  - inspección para un viaje en 390 px: progreso, los cuatro resultados (con el teclado), cantidad encontrada con el
 *    resultado sugerido, observación y foto; completar solo con todo marcado y tras el resumen;
 *  - completada: solo lectura; rectificación enlazada; historial en Flota y control preoperacional en la ficha;
 *  - axe (WCAG 2.1 AA) en cada pantalla y diálogo; modo oscuro y 390 px sin desplazamiento horizontal.
 */
test.describe.configure({ mode: 'serial' });

const SLUG = 'naviera-del-oriente';
const HOST = `${SLUG}.${E2E.baseDomain}`;
const PASSWORD = 'naviera-del-oriente-2026';

const dialog = (page: Page) => page.locator('dialog[open]');
const lima = (offset = 0) => {
  const d = new Date(
    `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date())}T00:00:00Z`,
  );
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

/** PNG de 1 × 1 px (la API lo recodifica a JPEG sin metadatos). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

/** Abre Flota en la lancha. */
async function openBoat(page: Page) {
  await page.goto(hostUrl(HOST, '/panel/flota'));
  await expect(page.getByRole('heading', { name: 'LANCHA-01 · Lancha Oriente' })).toBeVisible();
}

test('preparación: empresa fluvial, lancha con plano, ruta y un viaje con la lancha', async ({ browser }) => {
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
      legalName: 'Naviera del Oriente S.A.C.',
      tradeName: 'Naviera del Oriente',
      taxIdType: 'RUC',
      taxId: '20605334455',
      planVersionId,
      services: [{ modality: 'RIVER', service: 'PASSENGER' }],
      firstAdminEmail: `gerencia@${SLUG}.pe`,
    })) as { firstAdminInvitation: { link: string } };
  });

  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(hostUrl(E2E.hubHost, `/invitacion#${created.firstAdminInvitation.link.split('#')[1]}`));
  await admin.getByLabel('Tu nombre completo').fill('Jorge Prado');
  await admin.getByLabel('Crea una contraseña').fill(PASSWORD);
  await admin.getByLabel('Repite la contraseña').fill(PASSWORD);
  await admin.getByRole('button', { name: 'Crear mi cuenta y aceptar' }).click();
  await expect(admin.getByRole('heading', { name: 'Ya formas parte de Naviera del Oriente' })).toBeVisible();
  await followHttpRedirects(admin);
  await admin.goto(hostUrl(HOST, '/panel'));
  await admin.getByRole('link', { name: 'Iniciar sesión' }).click();
  await expect(admin).toHaveURL(/\/panel\//);

  const ids: string[] = [];
  for (const place of [
    { name: 'Pucallpa', kind: 'PORT', lat: -8.3791, lng: -74.5539 },
    { name: 'Contamana', kind: 'PORT', lat: -7.3333, lng: -75.0167 },
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
  const route = await tenantPost<{ id: string }>(admin, '/api/v1/routes', {
    code: 'PCL-CTM',
    name: 'Pucallpa – Contamana',
    modality: 'RIVER',
    stops: [stop(0, 0, { allowsAlighting: false }), stop(1, 720, { allowsBoarding: false })],
  });
  const layout = await tenantPost<{ layoutId: string }>(admin, '/api/v1/layouts', {
    name: 'Lancha 60',
    modality: 'RIVER',
    vehicleTypeId: null,
    document: fastBoatTemplate(),
  });
  await tenantPost(admin, `/api/v1/layouts/${layout.layoutId}/publish`, {});
  const type = await tenantPost<{ id: string }>(admin, '/api/v1/vehicle-types', {
    name: 'Lancha',
    modality: 'RIVER',
    catalogCode: 'LANCHA',
  });
  const boat = await tenantPost<{ id: string }>(admin, '/api/v1/vehicles', {
    code: 'LANCHA-01',
    name: 'Lancha Oriente',
    vehicleTypeId: type.id,
    registration: 'PA-12345-EM',
    status: 'ACTIVE',
    ownership: 'OWN',
    nominalCapacity: { passengers: null, weightKg: null, volumeM3: null },
    features: [],
  });
  await tenantPost(admin, `/api/v1/vehicles/${boat.id}/layout-assignments`, {
    layoutId: layout.layoutId,
    version: 1,
    validFrom: lima(0),
    validTo: null,
  });
  await tenantPost(admin, '/api/v1/trips', {
    routeId: route.id,
    departureLocal: `${lima(1)}T07:00`,
    vehicleId: boat.id,
    layout: null,
    minPassengers: null,
    confirmationDeadlineLocal: null,
  });
  await ctx.storageState({ path: '.auth/oriente.json' });
  await ctx.close();
});

test.describe('con la sesión de la empresa', () => {
  test.use({ storageState: '.auth/oriente.json', viewport: { width: 1440, height: 900 } });

  test('Flota: catálogo de la modalidad, elemento propio, editar con vencimiento y eliminar', async ({
    page,
  }) => {
    await openBoat(page);
    const eq = page.getByRole('region', { name: 'Equipamiento de la unidad' });
    await expect(eq.getByText(/^Sin equipamiento declarado\./)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nueva inspección' })).toBeDisabled();
    await expect(
      page.getByText('Para inspeccionar, primero declara el equipamiento de la unidad.'),
    ).toBeVisible();
    await expectAccessible(page, 'flota sin equipamiento');

    // Catálogo: lo fluvial y lo general, no lo terrestre; con la referencia orientativa.
    await eq.getByRole('button', { name: 'Agregar desde el catálogo' }).click();
    let d = dialog(page);
    const vests = d.getByRole('checkbox', { name: 'Chalecos salvavidas', exact: true });
    await expect(vests).toHaveAccessibleDescription(
      'Seguridad · Referencia orientativa: RD 970-2022-MGP/DICAPI (RESEP-FLUVIAL) y DS 014-2006-MTC.',
    );
    await expect(d.getByText('Neumático de repuesto')).toHaveCount(0);
    await vests.check();
    await d.getByLabel('Cantidad de Chalecos salvavidas').fill('40');
    await d.getByRole('checkbox', { name: 'Extintor', exact: true }).check();
    await d.getByLabel('Cantidad de Extintor').fill('2');
    await d.getByRole('checkbox', { name: 'Linterna', exact: true }).check();
    await expectAccessible(page, 'diálogo catálogo');
    await d.getByRole('button', { name: 'Agregar 3' }).click();
    await expect(d).toHaveCount(0);
    await expect(page.getByText('3 elementos agregados')).toBeAttached();
    const list = page.getByRole('list', { name: 'Equipamiento declarado de Lancha Oriente' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list.getByRole('listitem').filter({ hasText: 'Chalecos salvavidas' })).toContainText(
      'Sin verificar',
    );

    // Elemento propio, guardado también en el catálogo de la empresa.
    await eq.getByRole('button', { name: 'Elemento propio' }).click();
    d = dialog(page);
    await d.getByLabel('Nombre').fill('Bote auxiliar');
    await d.getByLabel('Categoría').selectOption({ label: 'Emergencia' });
    await d.getByLabel('Guardarlo también en el catálogo de la empresa').check();
    await expectAccessible(page, 'diálogo elemento propio');
    await d.getByRole('button', { name: 'Agregar' }).click();
    await expect(d).toHaveCount(0);
    await expect(list.getByRole('listitem')).toHaveCount(4);

    // Editar: operativo y con vencimiento cercano (por vencer).
    await page.getByRole('button', { name: 'Editar Chalecos salvavidas' }).click();
    d = dialog(page);
    await d.getByLabel('Estado').selectOption({ label: 'Operativo' });
    await d.getByLabel('Vencimiento (opcional)').fill(lima(10));
    await d.getByRole('button', { name: 'Guardar' }).click();
    await expect(d).toHaveCount(0);
    const vestRow = list.getByRole('listitem').filter({ hasText: 'Chalecos salvavidas' });
    await expect(vestRow).toContainText('Operativo');
    await expect(vestRow).toContainText(/Vence el/);

    // Eliminar archiva: desaparece de la unidad.
    await page.getByRole('button', { name: 'Eliminar Linterna de la unidad' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(3);

    // El catálogo de la empresa tiene el elemento propio; ya declarado no se vuelve a elegir.
    await eq.getByRole('button', { name: 'Catálogo de la empresa' }).click();
    d = dialog(page);
    await expect(d.getByText('Bote auxiliar')).toBeVisible();
    await expectAccessible(page, 'diálogo catálogo de la empresa');
    await d.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await eq.getByRole('button', { name: 'Agregar desde el catálogo' }).click();
    d = dialog(page);
    await expect(
      d.getByRole('checkbox', { name: 'Bote auxiliar · de tu empresa · ya declarado' }),
    ).toBeDisabled();
    await d.getByRole('button', { name: 'Cancelar' }).click();
    await expectAccessible(page, 'flota con equipamiento');
    if (CAPTURAS) await capture(page, 'flota-equipamiento');
  });

  test('inspección en el celular: resultados, cantidad sugerida, foto, resumen y completar', async ({
    page,
  }) => {
    await openBoat(page);
    await page.getByRole('button', { name: 'Nueva inspección' }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Nueva inspección de LANCHA-01' })).toBeVisible();
    await d.getByLabel('Viaje (opcional)').selectOption({ index: 1 });
    await expectAccessible(page, 'diálogo nueva inspección');
    await d.getByRole('button', { name: 'Empezar inspección' }).click();
    await expect(page).toHaveURL(/\/panel\/inspecciones\/[0-9a-f-]{36}$/);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { level: 1, name: 'Inspección · LANCHA-01' })).toBeVisible();
    await expect(page.getByText(/Viaje PCL-CTM-/)).toBeVisible();
    await expect(page.getByText('0 de 3 elementos marcados')).toBeVisible();
    const complete = page.getByRole('button', { name: 'Completar inspección' });
    await expect(complete).toBeDisabled();
    await expect(page.getByText('Falta marcar 3 elementos.')).toBeVisible();
    await expectAccessible(page, 'inspección en borrador');
    await expectNoHorizontalScroll(page, 'inspección en 390 px');

    // Chalecos: 38 de 40 → sugiere «Observado»; se acepta la sugerencia.
    const vests = page.getByRole('region', { name: 'Chalecos salvavidas' });
    await vests.getByRole('button', { name: 'Agregar cantidad, observación o fotos' }).click();
    await vests.getByLabel('Cantidad encontrada').fill('38');
    await vests.getByLabel('Observación').click();
    await expect(vests.getByText(/Sugerido: Observado \(se encontró menos de lo declarado\)/)).toBeVisible();
    await vests.getByLabel('Observación').fill('Faltan 2 chalecos');
    await vests.getByRole('button', { name: 'Marcar observado' }).click();
    await expect(
      vests.getByRole('group', { name: 'Resultado de Chalecos salvavidas' }).getByRole('button', {
        name: 'Observado',
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('1 de 3 elementos marcados')).toBeVisible();
    await vests
      .locator('input[type="file"]')
      .setInputFiles({ name: 'chalecos.png', mimeType: 'image/png', buffer: PNG });
    await expect(vests.getByRole('img', { name: 'Fotos de Chalecos salvavidas, 1 de 1' })).toBeVisible();
    await expect(vests.getByRole('button', { name: 'Agregar foto (1 de 5)' })).toBeVisible();

    // Extintor con el teclado: foco en «Observado» del grupo, Mayús+Tab a «Conforme» y la barra espaciadora.
    const ext = page.getByRole('group', { name: 'Resultado de Extintor' });
    await ext.getByRole('button', { name: 'Observado' }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(ext.getByRole('button', { name: 'Conforme' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(ext.getByRole('button', { name: 'Conforme' })).toHaveAttribute('aria-pressed', 'true');

    await page
      .getByRole('group', { name: 'Resultado de Bote auxiliar' })
      .getByRole('button', { name: 'No disponible' })
      .click();
    await expect(page.getByText('3 de 3 elementos marcados')).toBeVisible();
    await expect(
      page.getByText('Verás un resumen para confirmar. Completada, ya no se edita.'),
    ).toBeVisible();
    await page.getByLabel('Notas (opcional)').fill('Revisión antes del zarpe');
    await page.getByLabel('Notas (opcional)').blur();
    await expectAccessible(page, 'inspección marcada');
    await expectNoHorizontalScroll(page, 'inspección marcada en 390 px');
    if (CAPTURAS) await capture(page, 'inspeccion-celular');

    await complete.click();
    const summary = dialog(page);
    await expect(summary.getByRole('heading', { name: 'Completar inspección' })).toBeVisible();
    await expect(summary.getByText('Chalecos salvavidas: observado — Faltan 2 chalecos')).toBeVisible();
    await expect(summary.getByText('Bote auxiliar: no disponible')).toBeVisible();
    await expectAccessible(page, 'diálogo resumen');
    await summary.getByRole('button', { name: 'Confirmar y completar' }).click();
    await expect(summary).toHaveCount(0);

    // Completada: solo lectura.
    await expect(
      page.getByText('1 conformes · 1 observados · 0 no operativos · 1 no disponibles'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Completar inspección' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Resultado de Extintor' })).toHaveCount(0);
    await expect(page.getByText('Encontrado: 38 de 40')).toBeVisible();
    await expect(page.getByText('Revisión antes del zarpe')).toBeVisible();
    await expectAccessible(page, 'inspección completada');
  });

  test('rectificación enlazada, historial en Flota y control preoperacional del viaje', async ({ page }) => {
    await openBoat(page);
    const history = page.getByRole('list', { name: 'Historial de inspecciones de Lancha Oriente' });
    await expect(history.getByRole('listitem')).toHaveCount(1);
    await expect(history).toContainText('Con observaciones');
    await expect(history).toContainText('1 conformes · 1 observados · 1 no operativos o no disponibles');
    await history.getByRole('link', { name: /^Ver la inspección/ }).click();

    await page.getByRole('button', { name: 'Rectificar' }).click();
    const d = dialog(page);
    await d.getByLabel('Motivo').fill('El bote auxiliar estaba en la cubierta inferior');
    await expectAccessible(page, 'diálogo rectificar');
    await d.getByRole('button', { name: 'Crear rectificación' }).click();
    await expect(
      page.getByText(/^Rectifica la inspección original\. Motivo: El bote auxiliar/),
    ).toBeVisible();
    for (const name of ['Chalecos salvavidas', 'Extintor', 'Bote auxiliar']) {
      await page
        .getByRole('group', { name: `Resultado de ${name}` })
        .getByRole('button', { name: name === 'Chalecos salvavidas' ? 'Observado' : 'Conforme' })
        .click();
    }
    await page.getByRole('button', { name: 'Completar inspección' }).click();
    await dialog(page).getByRole('button', { name: 'Confirmar y completar' }).click();
    await expect(
      page.getByText('2 conformes · 1 observados · 0 no operativos · 0 no disponibles'),
    ).toBeVisible();

    // La original queda visible y marcada como rectificada.
    await page.getByRole('link', { name: 'inspección original' }).click();
    await expect(page.getByText(/^Rectificada\. La corrección está en/)).toBeVisible();
    await expect(
      page.getByText('1 conformes · 1 observados · 0 no operativos · 1 no disponibles'),
    ).toBeVisible();

    await openBoat(page);
    await expect(history.getByRole('listitem')).toHaveCount(2);
    await expect(history.getByRole('listitem').first()).toContainText('Rectifica la del');
    await expect(history.getByRole('listitem').nth(1)).toContainText('Rectificada');

    // Control preoperacional de la ficha: la última inspección, hecha para este viaje (la rectificación lo hereda).
    await page.goto(hostUrl(HOST, '/panel/viajes'));
    await page
      .getByRole('link', { name: /07:00 Pucallpa → Contamana/ })
      .first()
      .click();
    const pre = page.getByRole('region', { name: 'Control preoperacional' });
    await expect(pre).toContainText('Última inspección de LANCHA-01');
    await expect(pre).toContainText('2 conformes · 1 observados · 0 no operativos o no disponibles');
    await expect(pre).toContainText('Hecha para este viaje');
    await expect(pre.getByRole('button', { name: 'Inspeccionar para este viaje' })).toBeVisible();
    await expectAccessible(page, 'ficha con control preoperacional');
  });

  for (const scheme of ['dark', 'light'] as const) {
    test(`${scheme === 'dark' ? 'modo oscuro' : 'móvil (390 px)'}: Flota con equipamiento e inspección`, async ({
      page,
    }) => {
      if (scheme === 'dark') await page.emulateMedia({ colorScheme: 'dark' });
      else await page.setViewportSize({ width: 390, height: 844 });
      const label = scheme === 'dark' ? 'oscuro' : 'móvil';
      await openBoat(page);
      await expect(
        page.getByRole('list', { name: 'Equipamiento declarado de Lancha Oriente' }),
      ).toBeVisible();
      if (scheme === 'light') await expectNoHorizontalScroll(page, `Flota en ${label}`);
      await expectAccessible(page, `Flota en ${label}`);
      await page
        .getByRole('list', { name: 'Historial de inspecciones de Lancha Oriente' })
        .getByRole('link', { name: /^Ver la inspección/ })
        .first()
        .click();
      await expect(page.getByRole('heading', { level: 1, name: 'Inspección · LANCHA-01' })).toBeVisible();
      if (scheme === 'light') await expectNoHorizontalScroll(page, `inspección en ${label}`);
      await expectAccessible(page, `inspección en ${label}`);

      // Un borrador nuevo (sin viaje), con los cuatro resultados visibles, y descartarlo.
      await openBoat(page);
      await page.getByRole('button', { name: 'Nueva inspección' }).click();
      await dialog(page).getByRole('button', { name: 'Empezar inspección' }).click();
      await expect(page.getByText('0 de 3 elementos marcados')).toBeVisible();
      await page
        .getByRole('group', { name: 'Resultado de Extintor' })
        .getByRole('button', { name: 'No operativo' })
        .click();
      await expect(page.getByText('1 de 3 elementos marcados')).toBeVisible();
      if (scheme === 'light') await expectNoHorizontalScroll(page, `borrador en ${label}`);
      await expectAccessible(page, `borrador en ${label}`);
      await page.getByRole('button', { name: 'Descartar borrador' }).click();
      await expectAccessible(page, `diálogo descartar en ${label}`);
      await dialog(page).getByRole('button', { name: 'Descartar' }).click();
      await expect(page).toHaveURL(/\/panel\/flota\?vehiculo=/);
      await expect(
        page.getByRole('list', { name: 'Historial de inspecciones de Lancha Oriente' }).getByRole('listitem'),
      ).toHaveCount(2);
    });
  }
});
