import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll } from '../support/a11y';
import { apiPost } from '../support/api';
import { CAPTURAS, capture } from '../support/capture';
import { withDb } from '../support/db';
import { E2E, hostUrl } from '../support/env';
import { followHttpRedirects } from '../support/tenant-login';

/**
 * Fase 6.5b · Agencias externas en el panel de la empresa (API de la 6.5a, F6-Q2):
 *  - sin el módulo AGENCIES la sección no aparece en el carril, y su dirección lo explica;
 *  - YEBO enciende el módulo con una excepción y «Agencias» aparece;
 *  - alta con el RUC comprobado junto al campo, edición, archivar y restaurar, y su canal de venta en
 *    «Ubicaciones › Canales de venta» con el nombre de la agencia.
 * axe (WCAG 2.1 AA) en cada pantalla y diálogo; modo oscuro y 390 px sin desplazamiento horizontal.
 */
test.describe.configure({ mode: 'serial' });

const SLUG = 'viajes-del-oriente';
const HOST = `${SLUG}.${E2E.baseDomain}`;
const ADMIN_EMAIL = `gerencia@${SLUG}.pe`;
const PASSWORD = 'agencias-del-oriente-2026';
/** RUC reales con su dígito verificador (BCP y SUNAT). */
const RUC = '20100047218';
const OTHER_RUC = '20131312955';

let tenantId = '';

const dialog = (page: Page) => page.locator('dialog[open]');
const nav = (page: Page) => page.getByRole('navigation', { name: 'Secciones del panel' });

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

test('preparación: empresa sin el módulo de agencias y su administradora registrada', async ({ browser }) => {
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
      legalName: 'Transportes del Oriente S.A.C.',
      tradeName: 'Transportes del Oriente',
      taxIdType: 'RUC',
      taxId: '20604851751',
      planVersionId,
      services: [{ modality: 'RIVER', service: 'PASSENGER' }],
      firstAdminEmail: ADMIN_EMAIL,
    })) as { id: string; firstAdminInvitation: { link: string } };
  });
  tenantId = created.id;

  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(hostUrl(E2E.hubHost, `/invitacion#${created.firstAdminInvitation.link.split('#')[1]}`));
  await admin.getByLabel('Tu nombre completo').fill('Gerencia E2E');
  await admin.getByLabel('Crea una contraseña').fill(PASSWORD);
  await admin.getByLabel('Repite la contraseña').fill(PASSWORD);
  await admin.getByRole('button', { name: 'Crear mi cuenta y aceptar' }).click();
  await expect(
    admin.getByRole('heading', { name: 'Ya formas parte de Transportes del Oriente' }),
  ).toBeVisible();
  await ctx.storageState({ path: '.auth/oriente.json' });
  await ctx.close();
});

test.describe('con la sesión de la empresa', () => {
  test.use({ storageState: '.auth/oriente.json', viewport: { width: 1440, height: 900 } });

  test('sin el módulo: «Agencias» no está en el carril y su dirección lo explica', async ({ page }) => {
    await followHttpRedirects(page);
    await page.goto(hostUrl(HOST, '/panel'));
    await page.getByRole('link', { name: 'Iniciar sesión' }).click();
    await expect(page).toHaveURL(/\/panel\//);
    await expect(nav(page).getByRole('link', { name: 'Ubicaciones' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Agencias' })).toHaveCount(0);
    await page.context().storageState({ path: '.auth/oriente.json' });

    await page.goto(hostUrl(HOST, '/panel/agencias'));
    await expect(page.getByText('Tu empresa aún no tiene el módulo de agencias externas.')).toBeVisible();
    await expectAccessible(page, 'agencias sin el módulo');
  });

  test('con el módulo que enciende YEBO: alta, RUC comprobado, edición, archivar y restaurar', async ({
    page,
    browser,
  }) => {
    await asStaff(browser, (staff) =>
      apiPost(staff, `/api/v1/platform/tenants/${tenantId}/module-overrides`, {
        moduleCode: 'AGENCIES',
        effect: 'GRANT',
        reason: 'Piloto de agencias externas (E2E)',
      }),
    );
    await page.goto(hostUrl(HOST, '/panel/ubicaciones'));
    await nav(page).getByRole('link', { name: 'Agencias' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Agencias' })).toBeVisible();
    await expect(page.getByText(/^Aún no hay agencias/)).toBeVisible();
    await expectAccessible(page, 'agencias vacía');

    // Alta: un RUC con el dígito verificador equivocado se marca junto al campo, sin enviar.
    await page.getByRole('button', { name: 'Nueva agencia' }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Nueva agencia' })).toBeVisible();
    const ruc = d.getByRole('textbox', { name: 'RUC' });
    await ruc.fill('20100-0472 19 7'); // pegado con guiones y espacios: quedan los dígitos, hasta 11
    await expect(ruc).toHaveValue('20100047219');
    await d.getByLabel('Nombre', { exact: true }).fill('Viajes Amazonía');
    await d.getByLabel('Persona de contacto').fill('Rosa Pérez');
    await d.getByLabel('Teléfono').fill('+51 61 575757');
    await d.getByLabel('Correo').fill('Ventas@ViajesAmazonia.pe');
    await d.getByRole('button', { name: 'Crear agencia' }).click();
    await expect(d.getByText(/^Revisa el RUC/)).toBeVisible();
    await expect(ruc).toBeFocused();
    await expect(ruc).toHaveAttribute('aria-invalid', 'true');
    await expectAccessible(page, 'diálogo nueva agencia con el RUC por corregir');
    if (CAPTURAS) await capture(page, 'agencia-nueva');
    await ruc.fill(RUC);
    await d.getByRole('button', { name: 'Crear agencia' }).click();
    await expect(d).toHaveCount(0);
    await expect(page.getByText('Agencia Viajes Amazonía guardada')).toBeAttached();

    const row = page.getByRole('row', { name: /Viajes Amazonía/ });
    await expect(row.getByText(`RUC ${RUC}`)).toBeVisible();
    await expect(row.getByText('ventas@viajesamazonia.pe', { exact: false })).toBeVisible();
    await expect(row.getByText(`AGENCIA-${RUC}`)).toBeVisible();
    await expect(row.getByText('Activa', { exact: true })).toBeVisible();

    // El mismo RUC otra vez: la API lo rechaza y el diálogo lo dice.
    await page.getByRole('button', { name: 'Nueva agencia' }).click();
    await d.getByRole('textbox', { name: 'RUC' }).fill(RUC);
    await d.getByLabel('Nombre', { exact: true }).fill('Repetida');
    await d.getByRole('button', { name: 'Crear agencia' }).click();
    await expect(d.getByText(/Ya existe una agencia con el RUC 20100047218/)).toBeVisible();
    await d.getByRole('textbox', { name: 'RUC' }).fill(OTHER_RUC);
    await d.getByLabel('Nombre', { exact: true }).fill('Turismo Selva');
    await d.getByRole('button', { name: 'Crear agencia' }).click();
    await expect(d).toHaveCount(0);

    // Editar: el RUC no se ofrece; vaciar el teléfono lo quita.
    await page.getByRole('button', { name: 'Editar Viajes Amazonía' }).click();
    await expect(d.getByText(`RUC ${RUC} (no cambia).`)).toBeVisible();
    await expect(d.getByRole('textbox', { name: 'RUC' })).toHaveCount(0);
    await d.getByLabel('Nombre', { exact: true }).fill('Viajes Amazonía SAC');
    await d.getByLabel('Teléfono').fill('');
    await expectAccessible(page, 'diálogo editar agencia');
    await d.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(d).toHaveCount(0);
    const edited = page.getByRole('row', { name: /Viajes Amazonía SAC/ });
    await expect(edited.getByText('+51 61 575757')).toHaveCount(0);

    // Archivar: la agencia y su canal quedan inactivos; restaurar los devuelve.
    await page.getByRole('button', { name: 'Archivar Viajes Amazonía SAC' }).click();
    await expect(page.getByText(/archivada; su canal queda inactivo$/)).toBeAttached();
    await expect(edited.getByText('Archivada', { exact: true })).toBeVisible();
    await expect(edited.getByText('Inactivo', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editar Viajes Amazonía SAC' })).toHaveCount(0);
    await expectAccessible(page, 'agencias con una archivada');
    if (CAPTURAS) await capture(page, 'agencias');
  });

  test('canales de venta: el de la agencia lleva su nombre y sigue a su agencia', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/ubicaciones'));
    await page.getByRole('tab', { name: 'Canales de venta' }).click();
    const row = page.getByRole('row', { name: /Agencia Viajes Amazonía/ });
    await expect(row.getByText('Agencia externa')).toBeVisible();
    await expect(row.getByText('Viajes Amazonía SAC (archivada)')).toBeVisible();
    // Con la agencia archivada, su canal no se activa desde aquí.
    await expect(page.getByRole('button', { name: /^Activar Agencia Viajes Amazonía/ })).toHaveCount(0);
    await expectAccessible(page, 'canales de venta con agencias');

    await nav(page).getByRole('link', { name: 'Agencias' }).click();
    await page.getByRole('button', { name: 'Restaurar Viajes Amazonía SAC' }).click();
    await expect(page.getByText(/restaurada; su canal vuelve a estar activo$/)).toBeAttached();
    const agency = page.getByRole('row', { name: /Viajes Amazonía SAC/ });
    await expect(agency.getByText('Activa', { exact: true })).toBeVisible();

    // Activa, su canal se pausa desde «Canales de venta».
    await page.getByRole('link', { name: 'Ubicaciones › Canales de venta' }).click();
    await page.getByRole('tab', { name: 'Canales de venta' }).click();
    await page.getByRole('button', { name: /^Desactivar Agencia Viajes Amazonía/ }).click();
    await expect(page.getByRole('button', { name: /^Activar Agencia Viajes Amazonía/ })).toBeVisible();
  });

  for (const scheme of ['dark', 'light'] as const) {
    test(`${scheme === 'dark' ? 'modo oscuro' : 'móvil (390 px)'}: Agencias y su diálogo`, async ({
      page,
    }) => {
      if (scheme === 'dark') await page.emulateMedia({ colorScheme: 'dark' });
      else await page.setViewportSize({ width: 390, height: 844 });
      const label = scheme === 'dark' ? 'oscuro' : 'móvil';
      await page.goto(hostUrl(HOST, '/panel/agencias'));
      await expect(page.getByRole('heading', { level: 1, name: 'Agencias' })).toBeVisible();
      // Con la tabla ya cargada: es la que puede desbordar.
      await expect(page.getByRole('region', { name: 'Agencias' })).toBeVisible();
      if (scheme === 'light') await expectNoHorizontalScroll(page, `Agencias en ${label}`);
      await expectAccessible(page, `Agencias en ${label}`);
      await page.getByRole('button', { name: 'Nueva agencia' }).click();
      await expect(dialog(page).getByRole('heading', { name: 'Nueva agencia' })).toBeVisible();
      if (scheme === 'light') await expectNoHorizontalScroll(page, `diálogo en ${label}`);
      await expectAccessible(page, `diálogo nueva agencia en ${label}`);
      if (CAPTURAS) await capture(page, `agencias-${label}`);
    });
  }
});
