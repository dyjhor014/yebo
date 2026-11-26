import { expect, test, type Browser, type Page } from '@playwright/test';
import { bus, lancha } from '../../../apps/api/test/support/criterion-layouts';
import { expectAccessible, expectNoHorizontalScroll } from '../support/a11y';
import { apiPost } from '../support/api';
import { CAPTURAS, capture } from '../support/capture';
import { withDb } from '../support/db';
import { E2E, hostUrl } from '../support/env';
import { followHttpRedirects } from '../support/tenant-login';

/**
 * Fase 7.7 · Criterio de aceptación con las pantallas: «ruta multiparada con capacidad correcta por tramo».
 * La misma lancha y el mismo bus de dos pisos de la 6.6 (y de la prueba de integración phase7-criterion), en la ruta
 * fluvial Pucallpa → Contamana → Yurimaguas → Iquitos y en la terrestre Pucallpa → Aguaytía → Tingo María. Desde la
 * ficha del viaje: abrir a la venta, bloquear en tramos superpuestos y contiguos, ver lo rechazado con su tramo y la
 * disponibilidad de cada lugar y cada cupo, tramo por tramo (cifras escritas a mano).
 */
test.describe.configure({ mode: 'serial' });

const SLUG = 'selva-rios-y-carreteras';
const HOST = `${SLUG}.${E2E.baseDomain}`;
const PASSWORD = 'selva-rios-y-carreteras-2026';

const dialog = (page: Page) => page.locator('dialog[open]');
const lima = (offset = 0) => {
  const d = new Date(
    `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date())}T00:00:00Z`,
  );
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

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

const trips = { rio: '', carretera: '' };

/** Un bloqueo desde la ficha: desde, hasta, lugares y cupos (por su nombre en el diálogo). */
async function blockFromUi(
  page: Page,
  from: string,
  to: string,
  places: string,
  pools: Record<string, string> = {},
) {
  await page.getByRole('button', { name: 'Nuevo bloqueo' }).click();
  const d = dialog(page);
  await d.getByLabel('Desde').selectOption({ label: from });
  await d.getByLabel('Hasta').selectOption({ label: to });
  if (places) await d.getByLabel('Lugares (opcional)').fill(places);
  for (const [label, qty] of Object.entries(pools)) await d.getByLabel(label, { exact: true }).fill(qty);
  await d.getByRole('button', { name: 'Bloquear' }).click();
  return d;
}

/** Elige el tramo con el teclado (foco en el primero, Tab hasta el pedido y la barra espaciadora). */
async function pickSegment(page: Page, index: number) {
  const group = page.getByRole('group', { name: 'Tramo' });
  await group.getByRole('button').first().focus();
  for (let i = 0; i < index; i += 1) await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect(group.getByRole('button').nth(index)).toHaveAttribute('aria-pressed', 'true');
}

/** Lugares de una zona en el tramo elegido: código → «libre» u «ocupado». */
async function placesOf(page: Page, zone: string, codes: string[]) {
  const list = page.getByRole('list', { name: `Lugares de la zona ${zone} en el tramo elegido` });
  const out: Record<string, string> = {};
  for (const c of codes) {
    const text = (
      await list
        .getByRole('listitem')
        .filter({ hasText: new RegExp(`^${c} `) })
        .innerText()
    )
      .replace(/\s+/g, ' ')
      .trim();
    out[c] = text.endsWith('ocupado') ? 'ocupado' : 'libre';
  }
  return out;
}

test('preparación: la lancha y el bus de la 6.6, sus dos rutas y un viaje planificado en cada una', async ({
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
      legalName: 'Selva Ríos y Carreteras S.A.C.',
      tradeName: 'Selva Ríos y Carreteras',
      taxIdType: 'RUC',
      taxId: '20605556677',
      planVersionId,
      services: [
        { modality: 'RIVER', service: 'PASSENGER' },
        { modality: 'RIVER', service: 'PARCEL' },
        { modality: 'RIVER', service: 'CARGO' },
        { modality: 'LAND', service: 'PASSENGER' },
      ],
      firstAdminEmail: `operaciones@${SLUG}.pe`,
    })) as { firstAdminInvitation: { link: string } };
  });

  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(hostUrl(E2E.hubHost, `/invitacion#${created.firstAdminInvitation.link.split('#')[1]}`));
  await admin.getByLabel('Tu nombre completo').fill('Operaciones E2E');
  await admin.getByLabel('Crea una contraseña').fill(PASSWORD);
  await admin.getByLabel('Repite la contraseña').fill(PASSWORD);
  await admin.getByRole('button', { name: 'Crear mi cuenta y aceptar' }).click();
  await expect(
    admin.getByRole('heading', { name: 'Ya formas parte de Selva Ríos y Carreteras' }),
  ).toBeVisible();
  await followHttpRedirects(admin);
  await admin.goto(hostUrl(HOST, '/panel'));
  await admin.getByRole('link', { name: 'Iniciar sesión' }).click();
  await expect(admin).toHaveURL(/\/panel\//);

  const loc: Record<string, string> = {};
  for (const [key, place] of Object.entries({
    pucallpa: { name: 'Puerto Pucallpa', kind: 'PORT', lat: -8.3791, lng: -74.5539 },
    contamana: { name: 'Contamana', kind: 'PORT', lat: -7.3352, lng: -75.0094 },
    yurimaguas: { name: 'Yurimaguas', kind: 'LANDING', lat: -5.8984, lng: -76.0911 },
    iquitos: { name: 'Iquitos', kind: 'PORT', lat: -3.7491, lng: -73.2472 },
    terminal: { name: 'Terminal Pucallpa', kind: 'TERMINAL', lat: -8.3929, lng: -74.5826 },
    aguaytia: { name: 'Aguaytía', kind: 'TERMINAL', lat: -9.0367, lng: -75.5089 },
    tingo: { name: 'Tingo María', kind: 'TERMINAL', lat: -9.2953, lng: -75.9975 },
  })) {
    loc[key] = (
      await tenantPost<{ id: string }>(admin, '/api/v1/locations', { ...place, ubigeo: null, region: null })
    ).id;
  }
  const unit = async (code: string, modality: 'RIVER' | 'LAND', document: unknown) => {
    const layout = await tenantPost<{ layoutId: string }>(admin, '/api/v1/layouts', {
      name: code,
      modality,
      vehicleTypeId: null,
      document,
    });
    await tenantPost(admin, `/api/v1/layouts/${layout.layoutId}/publish`, {});
    const type = await tenantPost<{ id: string }>(admin, '/api/v1/vehicle-types', {
      name: `Tipo ${code}`,
      modality,
      catalogCode: null,
    });
    const v = await tenantPost<{ id: string }>(admin, '/api/v1/vehicles', {
      code,
      name: code,
      vehicleTypeId: type.id,
      registration: `${code}-PE`,
      status: 'ACTIVE',
      ownership: 'OWN',
      nominalCapacity: { passengers: null, weightKg: null, volumeM3: null },
      features: [],
    });
    await tenantPost(admin, `/api/v1/vehicles/${v.id}/layout-assignments`, {
      layoutId: layout.layoutId,
      version: 1,
      validFrom: lima(0),
      validTo: null,
    });
    return v.id;
  };
  const lanchaId = await unit('LANCHA-01', 'RIVER', lancha);
  const busId = await unit('BUS-2P', 'LAND', bus);
  const stop = (key: string, offsetMinutes: number, boarding = true, alighting = true) => ({
    locationId: loc[key],
    offsetMinutes,
    dwellMinutes: 0,
    allowsBoarding: boarding,
    allowsAlighting: alighting,
    pathToNext: null,
  });
  const rio = await tenantPost<{ id: string }>(admin, '/api/v1/routes', {
    code: 'PCL-IQT',
    name: 'Pucallpa – Iquitos',
    modality: 'RIVER',
    stops: [
      stop('pucallpa', 0, true, false),
      stop('contamana', 720),
      stop('yurimaguas', 2160),
      stop('iquitos', 5040, false, true),
    ],
  });
  const carretera = await tenantPost<{ id: string }>(admin, '/api/v1/routes', {
    code: 'PCL-TGM',
    name: 'Pucallpa – Tingo María',
    modality: 'LAND',
    stops: [stop('terminal', 0, true, false), stop('aguaytia', 180), stop('tingo', 360, false, true)],
  });
  const trip = (routeId: string, vehicleId: string, time: string) =>
    tenantPost<{ id: string }>(admin, '/api/v1/trips', {
      routeId,
      departureLocal: `${lima(1)}T${time}`,
      vehicleId,
      layout: null,
      minPassengers: null,
      confirmationDeadlineLocal: null,
    });
  trips.rio = (await trip(rio.id, lanchaId, '08:00')).id;
  trips.carretera = (await trip(carretera.id, busId, '07:00')).id;
  await ctx.storageState({ path: '.auth/rios.json' });
  await ctx.close();
});

test.describe('con la sesión de la empresa', () => {
  test.use({ storageState: '.auth/rios.json', viewport: { width: 1440, height: 900 } });

  test('lancha en 4 paradas: camarotes, camas y zona libre en tramos superpuestos y contiguos', async ({
    page,
  }) => {
    await page.goto(hostUrl(HOST, `/panel/viajes/${trips.rio}`));
    await page.getByRole('button', { name: 'Abrir a la venta' }).click();
    await expect(page.getByText('A la venta', { exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Tramo' }).getByRole('button')).toHaveText([
      'Puerto Pucallpa → Contamana',
      'Contamana → Yurimaguas',
      'Yurimaguas → Iquitos',
    ]);

    // El camarote C1 completo y 10 en la zona libre, de Pucallpa a Yurimaguas.
    let d = await blockFromUi(page, 'Puerto Pucallpa', 'Yurimaguas', 'C1', { 'Zona LIBRE · personas': '10' });
    await expect(d).toHaveCount(0);
    // Contiguo: la cama C1-B1 y 30 en la zona libre de Yurimaguas a Iquitos.
    d = await blockFromUi(page, 'Yurimaguas', 'Iquitos', 'c1-b1', { 'Zona LIBRE · personas': '30' });
    await expect(d).toHaveCount(0);
    // Superpuesto: la cama C1-B2 entre Contamana y Yurimaguas ya está ocupada.
    d = await blockFromUi(page, 'Contamana', 'Yurimaguas', 'C1-B2');
    await expect(d.getByText('Ocupado entre Contamana y Yurimaguas: C1-B2')).toBeVisible();
    await expectAccessible(page, 'bloqueo rechazado en la lancha');
    await d.getByRole('button', { name: 'Cancelar' }).click();
    // Superpuesto en un cupo: la zona libre está llena en el último tramo.
    d = await blockFromUi(page, 'Contamana', 'Iquitos', '', { 'Zona LIBRE · personas': '1' });
    await expect(
      d.getByText('La zona LIBRE (personas) sin capacidad entre Yurimaguas y Iquitos'),
    ).toBeVisible();
    await d.getByRole('button', { name: 'Cancelar' }).click();

    // Tramo por tramo (con el teclado): las camas de C1 y C2.
    const beds = ['C1-B1', 'C1-B2', 'C2-B1', 'C2-B2'];
    const expected = [
      { 'C1-B1': 'ocupado', 'C1-B2': 'ocupado', 'C2-B1': 'libre', 'C2-B2': 'libre' },
      { 'C1-B1': 'ocupado', 'C1-B2': 'ocupado', 'C2-B1': 'libre', 'C2-B2': 'libre' },
      { 'C1-B1': 'ocupado', 'C1-B2': 'libre', 'C2-B1': 'libre', 'C2-B2': 'libre' },
    ];
    for (const [i, want] of expected.entries()) {
      await pickSegment(page, i);
      expect(await placesOf(page, 'CAMAROTES', beds)).toEqual(want);
    }
    // Zona libre (30): libre en cada tramo.
    await expect(page.getByRole('row', { name: /^Zona LIBRE · personas/ })).toHaveText(
      'Zona LIBRE · personas20 de 3020 de 300 de 30',
    );
    await expect(page.getByRole('row', { name: /^Aforo de la unidad/ })).toHaveText(
      'Aforo de la unidad · personas36 de 3636 de 3636 de 36',
    );
    await expectAccessible(page, 'lancha con bloqueos');
    if (CAPTURAS) await capture(page, 'criterio7-lancha');
  });

  test('bus de dos pisos en 3 paradas: asientos de los dos pisos y aforo, tramo por tramo', async ({
    page,
  }) => {
    await page.goto(hostUrl(HOST, `/panel/viajes/${trips.carretera}`));
    await page.getByRole('button', { name: 'Abrir a la venta' }).click();
    await expect(page.getByText('A la venta', { exact: true })).toBeVisible();

    await blockFromUi(page, 'Terminal Pucallpa', 'Aguaytía', '1A, 1B');
    await blockFromUi(page, 'Aguaytía', 'Tingo María', '1A');
    await blockFromUi(page, 'Terminal Pucallpa', 'Tingo María', '5A', {
      'Aforo de la unidad · personas': '4',
    });
    const d = await blockFromUi(page, 'Aguaytía', 'Tingo María', '2A, 5A');
    await expect(d.getByText('Ocupado entre Aguaytía y Tingo María: 5A')).toBeVisible();
    await d.getByRole('button', { name: 'Cancelar' }).click();

    await pickSegment(page, 0);
    await expect(page.getByRole('heading', { name: 'Zona PASAJEROS · 14 de 16 libres' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Zona PASAJEROS2 · 39 de 40 libres' })).toBeVisible();
    expect(await placesOf(page, 'PASAJEROS', ['1A', '1B', '2A'])).toEqual({
      '1A': 'ocupado',
      '1B': 'ocupado',
      '2A': 'libre',
    });
    await pickSegment(page, 1);
    await expect(page.getByRole('heading', { name: 'Zona PASAJEROS · 15 de 16 libres' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Zona PASAJEROS2 · 39 de 40 libres' })).toBeVisible();
    expect(await placesOf(page, 'PASAJEROS', ['1A', '1B', '2A'])).toEqual({
      '1A': 'ocupado',
      '1B': 'libre',
      '2A': 'libre',
    });
    expect(await placesOf(page, 'PASAJEROS2', ['5A', '14D'])).toEqual({ '5A': 'ocupado', '14D': 'libre' });
    await expect(page.getByRole('row', { name: /^Aforo de la unidad/ })).toHaveText(
      'Aforo de la unidad · personas52 de 5652 de 56',
    );
    await expectAccessible(page, 'bus con bloqueos');
    if (CAPTURAS) await capture(page, 'criterio7-bus');
  });

  for (const scheme of ['dark', 'light'] as const) {
    test(`${scheme === 'dark' ? 'modo oscuro' : 'móvil (390 px)'}: la ficha de la lancha con su ocupación`, async ({
      page,
    }) => {
      if (scheme === 'dark') await page.emulateMedia({ colorScheme: 'dark' });
      else await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(hostUrl(HOST, `/panel/viajes/${trips.rio}`));
      await expect(page.getByRole('heading', { name: 'Disponibilidad por tramo' })).toBeVisible();
      if (scheme === 'light') await expectNoHorizontalScroll(page, 'ficha de la lancha en 390 px');
      await expectAccessible(page, `ficha de la lancha en ${scheme === 'dark' ? 'oscuro' : 'móvil'}`);
    });
  }
});
