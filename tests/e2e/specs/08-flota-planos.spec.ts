import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll } from '../support/a11y';
import { apiPost } from '../support/api';
import { CAPTURAS, capture } from '../support/capture';
import { withDb } from '../support/db';
import { E2E, hostUrl } from '../support/env';
import { followHttpRedirects } from '../support/tenant-login';

/**
 * Fase 6.4d · Ubicaciones, Flota y Planos en el panel de la empresa (maqueta 6.4 v5):
 *  - Ubicaciones: alta con departamento, provincia y distrito (ubigeo del INEI) y la sucursal con su mostrador;
 *  - Planos: «Nuevo plano» desde la plantilla «Lancha rápida» y el editor: teclado del plano (un solo punto de Tab,
 *    flechas, Enter toma, Esc devuelve, Supr quita), deshacer, filas que no caben y «Antes de publicar», pisos y
 *    zonas, autoguardado que sobrevive a recargar y publicar;
 *  - Flota: tipo, vehículo y asignación del plano publicado.
 * axe (WCAG 2.1 AA) en cada pantalla y diálogo; modo oscuro y 390 px sin desplazamiento horizontal.
 */
test.describe.configure({ mode: 'serial' });

const SLUG = 'lanchas-ucayali';
const HOST = `${SLUG}.${E2E.baseDomain}`;
const ADMIN_EMAIL = `operaciones@${SLUG}.pe`;
const PASSWORD = 'navegando-el-ucayali-2026';
const PLAN = 'Lancha rápida E2E';

const dialog = (page: Page) => page.locator('dialog[open]');
const plane = (page: Page) => page.getByRole('tabpanel').getByRole('group', { name: /^Elementos de / });
const seat = (page: Page, code: string) =>
  plane(page).getByRole('button', { name: new RegExp(`^Asiento ${code},`) });
const saved = (page: Page) => expect(page.getByText(/^Guardado en el borrador/)).toBeVisible();

test('preparación: empresa fluvial y su administradora registrada desde la invitación', async ({
  browser,
}) => {
  const staff = await browser.newContext({
    storageState: '.auth/staff.json',
    baseURL: hostUrl(E2E.adminHost),
  });
  const page = await staff.newPage();
  await page.goto('/empresas');
  const planVersionId = await withDb(
    async (db) =>
      (
        await db.query<{ id: string }>(
          `SELECT v.id FROM plan_versions v JOIN plans p ON p.id = v.plan_id
            WHERE p.code = 'basico-e2e' AND v.status = 'PUBLISHED' ORDER BY v.version LIMIT 1`,
        )
      ).rows[0]?.id,
  );
  const created = (await apiPost(page, '/api/v1/platform/tenants', {
    slug: SLUG,
    legalName: 'Lanchas del Ucayali S.A.C.',
    tradeName: 'Lanchas del Ucayali',
    taxIdType: 'RUC',
    taxId: '20607654329',
    planVersionId,
    services: [
      { modality: 'RIVER', service: 'PASSENGER' },
      { modality: 'RIVER', service: 'PARCEL' },
    ],
    firstAdminEmail: ADMIN_EMAIL,
  })) as { firstAdminInvitation: { link: string } };
  await staff.close();

  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(hostUrl(E2E.hubHost, `/invitacion#${created.firstAdminInvitation.link.split('#')[1]}`));
  await admin.getByLabel('Tu nombre completo').fill('Operaciones E2E');
  await admin.getByLabel('Crea una contraseña').fill(PASSWORD);
  await admin.getByLabel('Repite la contraseña').fill(PASSWORD);
  await admin.getByRole('button', { name: 'Crear mi cuenta y aceptar' }).click();
  await expect(admin.getByRole('heading', { name: 'Ya formas parte de Lanchas del Ucayali' })).toBeVisible();
  await ctx.storageState({ path: '.auth/ucayali.json' });
  await ctx.close();
});

test.describe('con la sesión de la empresa', () => {
  test.use({ storageState: '.auth/ucayali.json', viewport: { width: 1440, height: 900 } });

  test('entrar: el panel muestra Ubicaciones, Flota y Planos', async ({ page }) => {
    await followHttpRedirects(page);
    await page.goto(hostUrl(HOST, '/panel'));
    await page.getByRole('link', { name: 'Iniciar sesión' }).click();
    await expect(page).toHaveURL(/\/panel\//);
    const nav = page.getByRole('navigation', { name: 'Secciones del panel' });
    for (const name of ['Ubicaciones', 'Flota', 'Planos'])
      await expect(nav.getByRole('link', { name })).toBeVisible();
    await page.context().storageState({ path: '.auth/ucayali.json' });
  });

  test('ubicaciones: puerto con ubigeo del INEI y sucursal con su mostrador', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/ubicaciones'));
    await expect(page.getByRole('heading', { level: 1, name: 'Ubicaciones' })).toBeVisible();
    await expectAccessible(page, 'ubicaciones vacía');

    await page.getByRole('button', { name: 'Nueva ubicación' }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Nueva ubicación' })).toBeVisible();
    await d.getByLabel('Nombre', { exact: true }).fill('Puerto Pucallpa');
    await d.getByLabel('Departamento').selectOption({ label: 'Ucayali' });
    await d.getByLabel('Provincia').selectOption({ label: 'Coronel Portillo' });
    await d.getByLabel('Distrito').selectOption('250101');
    await expect(d.getByText(/Ubigeo del INEI: 250101/)).toBeVisible();
    await expectAccessible(page, 'diálogo nueva ubicación');
    if (CAPTURAS) await capture(page, 'nueva-ubicacion');
    await d.getByRole('button', { name: 'Crear ubicación' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText('Puerto Pucallpa').first()).toBeVisible();

    const tabs = page.getByRole('tablist', { name: 'Ubicaciones, sucursales y canales' });
    await tabs.getByRole('tab', { name: 'Sucursales' }).click();
    await page.getByRole('button', { name: 'Nueva sucursal' }).click();
    await dialog(page).getByLabel('Código').fill('PUC');
    await dialog(page).getByLabel('Nombre', { exact: true }).fill('Pucallpa centro');
    await dialog(page).getByLabel('Dirección').fill('Jr. Tacna 450');
    await expectAccessible(page, 'diálogo nueva sucursal');
    await dialog(page).getByRole('button', { name: 'Crear sucursal' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText('Pucallpa centro').first()).toBeVisible();

    // La sucursal nace con su mostrador.
    await tabs.getByRole('tab', { name: 'Canales de venta' }).click();
    await expect(page.getByText('MOSTRADOR-PUC').first()).toBeVisible();
    await expectAccessible(page, 'canales de venta');
    if (CAPTURAS) await capture(page, 'ubicaciones');
  });

  test('planos: «Nuevo plano» desde la plantilla «Lancha rápida» abre el editor', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/planos'));
    await expect(page.getByRole('heading', { level: 1, name: 'Planos' })).toBeVisible();
    await expectAccessible(page, 'planos vacía');
    await page.getByRole('button', { name: 'Nuevo plano' }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Nuevo plano' })).toBeVisible();
    // Solo opera en la modalidad fluvial: no hay que elegirla, y el bus no se ofrece.
    await expect(d.getByRole('group', { name: 'Modalidad' })).toHaveCount(0);
    await expect(d.getByRole('radio', { name: /Bus 2\+2/ })).toHaveCount(0);
    await d.getByRole('radio', { name: /En blanco/ }).check();
    await expect(d.getByLabel('Escala de la grilla')).toBeVisible();
    await expectAccessible(page, 'diálogo nuevo plano (en blanco)');
    await d.getByRole('radio', { name: /Lancha rápida/ }).check();
    await expect(d.getByLabel('Escala de la grilla')).toHaveCount(0);
    await d.getByLabel('Nombre', { exact: true }).fill(PLAN);
    if (CAPTURAS) await capture(page, 'nuevo-plano');
    await d.getByRole('button', { name: 'Crear plano' }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: `${PLAN} · borrador de la versión 1` }),
    ).toBeVisible();
    await expect(page.getByText(/^Guardado en el borrador · celdas de 50 cm/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publicar versión 1…' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Listo para publicar' })).toBeVisible();
    await expectAccessible(page, 'editor del plano');
    if (CAPTURAS) await capture(page, 'editor');

    // A la altura de la ventana (maqueta, ronda 5): la página no se desplaza; solo las columnas laterales. Al bajar
    // hasta «Crear zona» en la columna izquierda, la cabecera y el plano siguen a la vista.
    const fit = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(fit, 'la página del editor no se desplaza').toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: /^Crear la zona en / }).focus();
    for (const box of [
      await page.getByRole('heading', { level: 1, name: /borrador de la versión 1/ }).boundingBox(),
      await page.getByRole('heading', { level: 2, name: 'Plano' }).boundingBox(),
      await seat(page, '1A').boundingBox(),
    ]) {
      expect(box?.y).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 900) + (box?.height ?? 0)).toBeLessThanOrEqual(900);
    }

    // El texto de cada asiento cabe en él con aire a los lados, también con filas de dos cifras («10A»), en el
    // tamaño de vista por omisión («Mediana»).
    for (const code of ['1A', '10A', '10D']) {
      const fits = await seat(page, code).evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return el.clientWidth - r.getBoundingClientRect().width;
      });
      expect(fits, `el texto de ${code} cabe en su asiento`).toBeGreaterThanOrEqual(2);
    }
  });

  test('editor: teclado del plano, deshacer y quitar', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/planos'));
    await page.getByRole('link', { name: `Editar ${PLAN}` }).click();
    await expect(page.getByRole('heading', { level: 1, name: /borrador de la versión 1/ })).toBeVisible();

    // Un solo punto de Tab en el plano: el primer elemento; los demás quedan fuera del orden de Tab.
    const stops = plane(page).locator('button[tabindex="0"]');
    await expect(stops).toHaveCount(1);
    await expect(plane(page).locator('button[tabindex="-1"]')).toHaveCount(40);

    await seat(page, '1A').focus();
    await expect(seat(page, '1A')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { level: 2, name: 'Asiento 1A' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(seat(page, '1B')).toBeFocused();
    await expect(seat(page, '1B')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(seat(page, '2B')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(seat(page, '1B')).toBeFocused();

    // Enter toma, flechas mueven y Esc devuelve.
    await page.keyboard.press('Enter');
    await expect(
      page.getByText('1B tomado: muévelo con las flechas, Enter para dejarlo, Esc para devolverlo'),
    ).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(seat(page, '1B')).toHaveAccessibleName(/columna 2, fila 4, tomado/);
    await page.keyboard.press('Escape');
    await expect(page.getByText('1B devuelto a su sitio')).toBeVisible();
    await expect(seat(page, '1B')).toHaveAccessibleName('Asiento 1B, columna 2, fila 3');
    await expect(seat(page, '1B')).toBeFocused();

    // Enter toma, flechas mueven y Enter deja; «Deshacer» lo devuelve.
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByText('1B colocado en la columna 2, fila 4')).toBeVisible();
    await saved(page);
    await page.getByRole('button', { name: 'Deshacer' }).first().click();
    await expect(seat(page, '1B')).toHaveAccessibleName('Asiento 1B, columna 2, fila 3');

    // Supr quita, con un aviso que permite deshacer.
    await seat(page, '1B').focus();
    await page.keyboard.press('Delete');
    await expect(seat(page, '1B')).toHaveCount(0);
    const toast = page.getByRole('status').filter({ hasText: 'Se quitó 1B' });
    await expect(toast).toBeVisible();
    await expectAccessible(page, 'editor con el aviso de deshacer');
    await toast.getByRole('button', { name: 'Deshacer' }).click();
    await expect(seat(page, '1B')).toBeVisible();
    await saved(page);
  });

  test('editor: filas que no caben, «Antes de publicar», pisos y zonas, y autoguardado', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/planos'));
    await page.getByRole('link', { name: `Editar ${PLAN}` }).click();
    await expect(page.getByRole('heading', { level: 1, name: /borrador de la versión 1/ })).toBeVisible();

    // Una fila 2 + 3 más no cabe en la zona de asientos: el editor lo avisa y no deja publicar.
    await page.getByLabel('Derecha').selectOption('3');
    await page.getByRole('spinbutton', { name: 'Filas' }).fill('1');
    await page.getByRole('button', { name: 'Añadir 1 fila 2 + 3' }).click();
    await expect(
      page.getByText(/^5 asientos en 1 fila 2 \+ 3 \(filas 11 a 11\); algunos no caben/),
    ).toBeVisible();
    const fix = page.getByRole('button', { name: /^Corregir \d+ datos? para publicar$/ });
    await expect(fix).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Antes de publicar' })).toBeVisible();
    await expectAccessible(page, 'editor con datos por corregir');
    if (CAPTURAS) await capture(page, 'editor-errores');
    // Cada problema lleva a lo que falla.
    await page
      .getByRole('button', { name: /^11A se sale de/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { level: 2, name: /^Asiento 11/ })).toBeVisible();
    await page.getByRole('button', { name: 'Deshacer' }).first().click();
    await expect(page.getByRole('button', { name: 'Publicar versión 1…' })).toBeVisible();

    // Un piso nuevo con una zona libre, que se ajusta en metros sin salir del piso.
    await page.getByRole('button', { name: 'Añadir piso' }).click();
    const decks = page.getByRole('tablist', { name: 'Pisos' });
    await expect(decks.getByRole('tab', { name: 'Piso 2' })).toHaveAttribute('aria-selected', 'true');
    await page.getByLabel('Nombre del piso').fill('Terraza');
    await page.getByLabel('Nombre del piso').press('Enter');
    await expect(decks.getByRole('tab', { name: 'Terraza' })).toBeVisible();
    await expect(page.getByText('Este piso aún no tiene zonas')).toBeVisible();
    await page.getByRole('combobox', { name: 'Tipo', exact: true }).selectOption({ label: 'Zona libre' });
    await page.getByRole('button', { name: 'Crear la zona en Terraza' }).click();
    await expect(page.getByText('Zona libre creada en Terraza, de la fila 1 a la 6')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Zona libre' })).toBeVisible();
    await page.getByRole('button', { name: 'Acortar la zona' }).click();
    await page.getByRole('button', { name: 'Mover la zona hacia la popa' }).click();
    await expect(page.getByText('Posición · columna 1, fila 2')).toBeVisible();
    // La zona no sale del piso: 3 m de ancho es todo el piso.
    await page.getByRole('button', { name: 'Ensanchar la zona' }).click();
    await expect(page.getByText(/^Tamaño · 3 m × 2\.5 m$/)).toBeVisible();
    await page.getByRole('textbox', { name: 'Personas', exact: true }).fill('12');
    await page.getByRole('textbox', { name: 'Personas', exact: true }).press('Enter');
    await expect(
      page.getByText('Personas en zonas libres').locator('xpath=following-sibling::dd[1]'),
    ).toHaveText('12');
    await expectAccessible(page, 'editor con una zona elegida');
    if (CAPTURAS) await capture(page, 'editor-zona');

    // El autoguardado deja el borrador en el servidor: al recargar sigue ahí.
    await saved(page);
    await page.reload();
    await expect(
      page.getByRole('tablist', { name: 'Pisos' }).getByRole('tab', { name: 'Terraza' }),
    ).toBeVisible();
    await page.getByRole('tablist', { name: 'Pisos' }).getByRole('tab', { name: 'Terraza' }).click();
    await expect(page.getByRole('button', { name: /^Zona libre/ }).first()).toContainText('12 personas');
  });

  test('publicar: el diálogo resume el plano y la versión publicada ya no cambia', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/planos'));
    await page.getByRole('link', { name: `Editar ${PLAN}` }).click();
    await page.getByRole('button', { name: 'Publicar versión 1…' }).click();
    const d = page.getByRole('dialog', { name: '¿Publicar la versión 1?' });
    await expect(
      d.getByText(/2 pisos: 40 asientos, 0 camarotes, 0 camas y 12 personas en zonas libres; aforo de 40/),
    ).toBeVisible();
    await expectAccessible(page, 'diálogo publicar el plano');
    if (CAPTURAS) await capture(page, 'publicar-plano');
    await d.getByRole('button', { name: 'Publicar la versión 1' }).click();
    await expect(page.getByText('Versión 1 publicada')).toBeAttached();
    await expect(page.getByRole('button', { name: 'Editar en una versión nueva' })).toBeVisible();
    await expect(page.getByText('Una versión publicada ya no cambia.')).toBeVisible();
    await expectAccessible(page, 'ficha del plano publicado');

    await page.goto(hostUrl(HOST, '/panel/planos'));
    await expect(page.getByRole('link', { name: `Ver ${PLAN}` })).toBeVisible();
  });

  test('flota: tipo, vehículo y asignación del plano publicado', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/flota'));
    await expect(page.getByRole('heading', { level: 1, name: 'Flota' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nuevo vehículo' })).toBeDisabled();
    await expectAccessible(page, 'flota vacía');

    await page.getByRole('button', { name: 'Tipos de vehículo' }).click();
    const types = page.getByRole('dialog', { name: 'Tipos de vehículo' });
    await types.getByLabel('Nombre', { exact: true }).fill('Lancha rápida');
    await expectAccessible(page, 'diálogo tipos de vehículo');
    await types.getByRole('button', { name: 'Crear tipo' }).click();
    await expect(types.getByText('Fluvial · 0 vehículos')).toBeVisible();
    await types.getByRole('button', { name: 'Cerrar', exact: true }).click();

    await page.getByRole('button', { name: 'Nuevo vehículo' }).click();
    const v = page.getByRole('dialog', { name: 'Nuevo vehículo' });
    await v.getByLabel('Código').fill('lancha-01');
    await expect(v.getByLabel('Código')).toHaveValue('LANCHA-01');
    await v.getByLabel('Nombre', { exact: true }).fill('Ucayali Express');
    await v.getByLabel('Placa o matrícula').fill('pa-12345-ef');
    await v.getByLabel('Pasajeros', { exact: true }).fill('40');
    await expectAccessible(page, 'diálogo nuevo vehículo');
    await v.getByRole('button', { name: 'Crear vehículo' }).click();
    await expect(page.getByText('Vehículo LANCHA-01 guardado')).toBeAttached();
    await expect(page.getByText('Sin plano asignado')).toBeVisible();

    await page.getByRole('button', { name: 'Asignar un plano…' }).click();
    const a = page.getByRole('dialog', { name: 'Asignar un plano' });
    await expect(a.getByLabel('Plano y versión')).toHaveValue(/:1$/);
    await expect(a.getByLabel('Plano y versión').locator('option:checked')).toHaveText(`${PLAN} · versión 1`);
    await expectAccessible(page, 'diálogo asignar un plano');
    await a.getByRole('button', { name: 'Asignar', exact: true }).click();
    await expect(page.getByText(`${PLAN}`).first()).toBeVisible();
    await expect(page.getByText('Vigente').first()).toBeVisible();
    await expectAccessible(page, 'ficha del vehículo con su plano');
    if (CAPTURAS) await capture(page, 'flota');

    // Planos refleja la asignación (y ya no ofrece archivar el plano).
    await page.goto(hostUrl(HOST, '/panel/planos'));
    await expect(page.getByText(/asignado a 1 vehículo/)).toBeVisible();
    await expect(page.getByRole('button', { name: `Archivar ${PLAN}` })).toHaveCount(0);
  });

  test('una versión nueva parte de la publicada, que sigue asignada', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/planos'));
    await page.getByRole('link', { name: `Ver ${PLAN}` }).click();
    await page.getByRole('button', { name: 'Editar en una versión nueva' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: `${PLAN} · borrador de la versión 2` }),
    ).toBeVisible();
    await expect(page.getByText(/la versión 1 sigue publicada/)).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Pisos' }).getByRole('tab')).toHaveCount(2);
  });

  for (const scheme of ['dark', 'light'] as const) {
    test(`${scheme === 'dark' ? 'modo oscuro' : 'móvil (390 px)'}: las pantallas y el editor`, async ({
      page,
    }) => {
      if (scheme === 'dark') await page.emulateMedia({ colorScheme: 'dark' });
      else await page.setViewportSize({ width: 390, height: 844 });
      const label = scheme === 'dark' ? 'oscuro' : 'móvil';
      for (const [path, h1] of [
        ['/panel/ubicaciones', 'Ubicaciones'],
        ['/panel/flota', 'Flota'],
        ['/panel/planos', 'Planos'],
      ] as const) {
        await page.goto(hostUrl(HOST, path));
        await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
        // Con los datos ya cargados: las tablas anchas son las que pueden desbordar.
        await expect(page.getByText(/^Cargando /)).toHaveCount(0);
        if (scheme === 'light') await expectNoHorizontalScroll(page, `${h1} en ${label}`);
        await expectAccessible(page, `${h1} en ${label}`);
      }
      await page.getByRole('link', { name: `Editar ${PLAN}` }).click();
      await expect(page.getByRole('heading', { level: 1, name: /borrador de la versión 2/ })).toBeVisible();
      await seat(page, '1A').click();
      if (scheme === 'light') await expectNoHorizontalScroll(page, `editor en ${label}`);
      await expectAccessible(page, `editor en ${label}`);
      if (CAPTURAS) await capture(page, `editor-${label}`);
    });
  }
});
