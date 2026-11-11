import { expect, test, type Page } from '@playwright/test';
import { crc32, deflateSync } from 'node:zlib';
import { expectAccessible, expectNoHorizontalScroll } from '../support/a11y';
import { apiPost } from '../support/api';
import { CAPTURAS, capture } from '../support/capture';
import { withDb } from '../support/db';
import { E2E, hostUrl } from '../support/env';

/**
 * Fase 5.4 · Editor «Mi sitio» del panel de la empresa: la persona administradora entra desde su invitación, edita
 * el tema (con el aviso de contraste que bloquea publicar), la portada, las secciones y el contacto, sube el logo,
 * ve la vista previa en un monitor y en un iPhone, publica y el portal cambia; el historial restaura una versión
 * anterior como versión nueva. axe (WCAG 2.1 AA) en el editor, el diálogo y el historial.
 */
test.describe.configure({ mode: 'serial' });

const SLUG = 'ribera-amazonica';
const HOST = `${SLUG}.${E2E.baseDomain}`;
const ADMIN_EMAIL = `gerencia@${SLUG}.pe`;
const PASSWORD = 'remando-por-el-amazonas-2026';

/** PNG RGB de `w` × `h` de un color (sin dependencias): el logo que se sube. */
function png(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).fill(Buffer.from([r, g, b]))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const preview = (page: Page) => page.locator('section[aria-labelledby="vista-previa"]');
const dialog = (page: Page) => page.locator('dialog[open]');

test('preparación: empresa con WHITE_LABEL y su administradora registrada desde la invitación', async ({
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
    legalName: 'Ribera Amazónica S.A.C.',
    tradeName: 'Ribera Amazónica',
    taxIdType: 'RUC',
    taxId: '20601234591',
    planVersionId,
    services: [
      { modality: 'RIVER', service: 'PASSENGER' },
      { modality: 'RIVER', service: 'CARGO' },
    ],
    firstAdminEmail: ADMIN_EMAIL,
  })) as { id: string; firstAdminInvitation: { link: string } };
  await apiPost(page, `/api/v1/platform/tenants/${created.id}/module-overrides`, {
    moduleCode: 'WHITE_LABEL',
    effect: 'GRANT',
    reason: 'Portal de marca propia (E2E del editor)',
  });
  await staff.close();

  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(hostUrl(E2E.hubHost, `/invitacion#${created.firstAdminInvitation.link.split('#')[1]}`));
  await admin.getByLabel('Tu nombre completo').fill('Gerencia E2E');
  await admin.getByLabel('Crea una contraseña').fill(PASSWORD);
  await admin.getByLabel('Repite la contraseña').fill(PASSWORD);
  await admin.getByRole('button', { name: 'Crear mi cuenta y aceptar' }).click();
  await expect(admin.getByRole('heading', { name: 'Ya formas parte de Ribera Amazónica' })).toBeVisible();
  await ctx.storageState({ path: '.auth/ribera.json' });
  await ctx.close();
});

test.describe('con la sesión de la empresa', () => {
  test.use({ storageState: '.auth/ribera.json', viewport: { width: 1440, height: 900 } });

  test('entrar: /panel lleva a «Mi sitio» tras iniciar sesión en la empresa', async ({ page }) => {
    // La API redirige entre la empresa y el hub siempre con https:// (producción) y los E2E sirven por http en el
    // proxy local: en las rutas de autenticación, la redirección a https:// se lleva al mismo host y ruta del proxy.
    await page.route(/\/api\/v1\/(auth|hub)\//, async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers()['location'];
      if (!location?.startsWith('https://')) return route.fulfill({ response });
      // Una página que navega (no otra redirección: los saltos de una redirección no pasan por page.route).
      const url = new URL(location);
      const target = hostUrl(url.hostname, `${url.pathname}${url.search}${url.hash}`);
      const headers: Record<string, string> = { ...response.headers(), 'content-type': 'text/html' };
      delete headers['location'];
      delete headers['content-security-policy']; // la de la API bloquearía este script de prueba
      return route.fulfill({
        status: 200,
        headers,
        body: `<script>location.replace(${JSON.stringify(target)})</script>`,
      });
    });
    await page.goto(hostUrl(HOST, '/panel'));
    await page.getByRole('link', { name: 'Iniciar sesión' }).click();
    await expect(page).toHaveURL(hostUrl(HOST, '/panel/sitio'));
    await expect(page.getByRole('heading', { level: 1, name: 'Mi sitio' })).toBeVisible();
    await expect(page.getByText('el sitio aún no se ha publicado')).toBeVisible();
    // Un sitio nunca publicado se puede publicar tal cual: no hay un botón desactivado sin explicación.
    await expect(page.getByRole('button', { name: 'Publicar…' })).toBeEnabled();
    await expect(
      page.getByRole('navigation', { name: 'Secciones del panel' }).getByRole('link', { name: 'Mi sitio' }),
    ).toHaveAttribute('aria-current', 'page');
    await page.context().storageState({ path: '.auth/ribera.json' });
  });

  test('editar: contraste que bloquea, tema, logo, portada, secciones y contacto, con vista previa', async ({
    page,
  }) => {
    await page.goto(hostUrl(HOST, '/panel/sitio'));
    await expect(page.getByRole('heading', { level: 1, name: 'Mi sitio' })).toBeVisible();
    await expectAccessible(page, 'editor: marca y tema');
    if (CAPTURAS) await capture(page, 'tema');

    const tabs = page.getByRole('tablist', { name: 'Partes del sitio' });
    // Las cinco pestañas caben en una fila (sin desplazamiento) en escritorio.
    expect(await tabs.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    // Verde lima como acento sobre el fondo claro: 1,2:1 → aviso junto al campo; la lista de problemas y el
    // contador de la pestaña aparecen al intentar guardar (no antes), y el enlace del resumen enfoca el campo.
    const accent = page.getByRole('textbox', { name: 'Color de acento', exact: true });
    await accent.fill('#C5F36B');
    await expect(
      page.getByText(/El color de acento sobre la superficie clara solo llega a 1\.\d+:1/),
    ).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Corrige este dato' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Guardar borrador' }).click();
    const summary = page.getByRole('alert').filter({ hasText: 'Corrige este dato para guardar o publicar' });
    await expect(summary).toBeFocused();
    await expect(tabs.getByRole('tab', { name: /Marca\s*1 dato por corregir/ })).toBeVisible();
    await page.getByRole('button', { name: 'Publicar…' }).click(); // no abre el diálogo: lleva a los problemas
    await expect(dialog(page)).toHaveCount(0);
    await summary.getByRole('button', { name: 'Color de acento' }).click();
    await expect(accent).toBeFocused();
    await expect(accent).toHaveAttribute('aria-invalid', 'true');
    await expectAccessible(page, 'editor con un aviso de contraste');

    // Fondo oscuro: el mismo acento pasa; principal lima; Lora y esquinas redondeadas.
    await page
      .getByRole('group', { name: 'Fondo del sitio' })
      .getByRole('button', { name: 'Oscuro' })
      .click();
    await expect(page.getByText('Los enlaces se leen bien (13,3:1).')).toBeVisible();
    await expect(summary).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Color principal', exact: true }).fill('#C5F36B');
    await page.getByLabel('Tipografía').selectOption('lora');
    await page.getByLabel('Esquinas').selectOption('round');
    await expect(page.getByRole('button', { name: 'Publicar…' })).toBeEnabled();

    // Logo: se sube (la API lo recodifica) y se ve en el editor y en la vista previa.
    await page.locator('input[type="file"]').setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: png(240, 120, [11, 61, 145]),
    });
    await expect(page.getByRole('img', { name: 'Vista de el logo' })).toBeVisible();
    await expect(preview(page).locator('img[alt="Ribera Amazónica"]')).toBeVisible();

    // Portada.
    await tabs.getByRole('tab', { name: 'Portada' }).click();
    await page.getByLabel('Título', { exact: true }).fill('Viaja con Ribera');
    await page.getByLabel('Subtítulo (opcional)').fill('Pasajeros y carga por el Amazonas.');
    await expect(preview(page).getByText('Viaja con Ribera')).toBeVisible();

    // Secciones: mostrar las preguntas y subirlas al principio.
    await tabs.getByRole('tab', { name: 'Secciones' }).click();
    await page.getByRole('checkbox', { name: /Preguntas frecuentes/ }).check();
    for (let i = 0; i < 3; i++)
      await page.getByRole('button', { name: 'Subir Preguntas frecuentes' }).click();
    await expect(page.getByRole('button', { name: 'Subir Preguntas frecuentes' })).toBeDisabled();
    await expectAccessible(page, 'editor: secciones');
    if (CAPTURAS) await capture(page, 'secciones');

    // Contacto y una pregunta. La vista previa se desplaza a la sección que se edita (Contacto va al final).
    await tabs.getByRole('tab', { name: 'Contacto' }).click();
    await page.getByLabel('WhatsApp (opcional)').fill('+51 965 432 100');
    await expect(preview(page).locator('#contact-t')).toBeInViewport();
    await page.getByRole('button', { name: 'Añadir sucursal' }).click();
    await expect(page.getByLabel('Nombre', { exact: true }).last()).toBeFocused();
    await page.getByLabel('Nombre', { exact: true }).last().fill('Iquitos');
    await page.getByLabel('Ciudad', { exact: true }).fill('Iquitos');
    await page.getByLabel('Dirección', { exact: true }).fill('Malecón Tarapacá 120');
    await tabs.getByRole('tab', { name: 'Información' }).click();
    await page.getByRole('button', { name: 'Añadir pregunta' }).click();
    await page.getByLabel('Pregunta', { exact: true }).fill('¿Puedo llevar mascotas?');
    await page.getByLabel('Respuesta', { exact: true }).fill('Sí, en su transportadora.');
    // Quitar se puede deshacer, con lo escrito.
    await page.getByRole('button', { name: 'Quitar pregunta 1' }).click();
    await expect(page.getByLabel('Pregunta', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Deshacer' }).click();
    await expect(page.getByLabel('Pregunta', { exact: true })).toHaveValue('¿Puedo llevar mascotas?');
    // Una política añadida y sin escribir no impide guardar (no se envía).
    await page.getByRole('button', { name: 'Añadir política' }).click();
    await expectAccessible(page, 'editor: más contenido');
    if (CAPTURAS) await capture(page, 'mas-contenido');

    // Vista previa: el portal del borrador con su tema, en el monitor y en el iPhone.
    const root = preview(page).locator('[style*="--site-bg"]');
    expect(await root.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(16, 29, 43)');
    await expect(preview(page).getByText('Monitor · 1280 × 800 px')).toBeVisible();
    await expect(preview(page).getByText('¿Puedo llevar mascotas?')).toBeVisible();
    await page.screenshot({ path: 'capturas/editor-escritorio.png', fullPage: true });
    await preview(page).getByRole('button', { name: 'iPhone' }).click();
    await expect(preview(page).getByText('iPhone · 390 × 844 px')).toBeVisible();
    await expect(preview(page).getByText('9:41')).toBeVisible();
    await page.screenshot({ path: 'capturas/editor-iphone.png', fullPage: true });

    // Ampliar: la misma vista previa, más grande, en un diálogo que se cierra con Esc.
    await preview(page).getByRole('button', { name: 'Ampliar' }).click();
    const zoom = page.getByRole('dialog', { name: 'Vista previa del borrador' });
    await expect(zoom.getByText(/iPhone · 390 × 844 px al (\d+) %/)).toBeVisible();
    const pct = Number((await zoom.getByText(/al \d+ %/).textContent())?.match(/al (\d+) %/)?.[1]);
    expect(pct).toBeGreaterThan(72);
    await expectAccessible(page, 'vista previa ampliada');
    await page.keyboard.press('Escape');
    await expect(zoom).toHaveCount(0);

    // Al final del formulario, la cabecera (estado, Guardar y Publicar), la vista previa y el carril siguen a la
    // vista (sticky); la captura de página completa no lo muestra, porque los pinta arriba.
    await page.getByLabel('Texto del pie (opcional)').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
    const viewport = page.viewportSize()?.height ?? 0;
    for (const box of [
      await preview(page).getByText('iPhone · 390 × 844 px').boundingBox(),
      await page.getByRole('navigation', { name: 'Secciones del panel' }).boundingBox(),
      await page.getByRole('button', { name: 'Publicar…' }).boundingBox(),
      await page.getByText('Cambios sin guardar').boundingBox(),
    ]) {
      expect(box?.y).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? viewport) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport);
    }
    await page.screenshot({ path: 'capturas/editor-desplazado.png' });

    // Guardar el borrador.
    await page.getByRole('button', { name: 'Guardar borrador' }).click();
    await expect(page.getByText('Borrador guardado, sin publicar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guardar borrador' })).toBeDisabled();
    await expect(page.getByText('Políticas · 0 de 10')).toBeVisible(); // la fila vacía no se guardó
  });

  test('publicar: el diálogo resume los cambios y el portal cambia al momento', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/sitio'));
    await page.getByRole('button', { name: 'Publicar…' }).click();
    await expect(dialog(page).getByRole('heading', { name: '¿Publicar el borrador?' })).toBeVisible();
    await expect(dialog(page).getByText('Primera publicación del sitio.')).toBeVisible();
    await expect(dialog(page).getByText('Tema: fondo oscuro, tipografía Lora y tu logo.')).toBeVisible();
    await expectAccessible(page, 'diálogo publicar');
    if (CAPTURAS) await capture(page, 'publicar');
    await dialog(page).getByRole('button', { name: 'Publicar la versión 1' }).click();
    await expect(dialog(page).getByText(/Versión 1 publicada/)).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Volver al editor' }).click();
    await expect(page.getByText('versión publicada: 1')).toBeVisible();

    await page.goto(hostUrl(HOST));
    await expect(page.getByRole('heading', { level: 1, name: 'Viaja con Ribera' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Ribera Amazónica' })).toBeVisible();
    const sections = page.getByRole('navigation', { name: 'Secciones' }).getByRole('link');
    await expect(sections.first()).toHaveText('Preguntas frecuentes');
    await expect(page.getByRole('link', { name: 'Escríbenos por WhatsApp' })).toHaveAttribute(
      'href',
      'https://wa.me/51965432100',
    );
    const root = page.locator('main').locator('..');
    expect(await root.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Lora/i);
    await expectAccessible(page, 'portal publicado desde el editor');
    if (CAPTURAS) await capture(page, 'portal');
  });

  test('segunda versión y restaurar la primera desde el historial (como versión nueva)', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/sitio'));
    await page
      .getByRole('tablist', { name: 'Partes del sitio' })
      .getByRole('tab', { name: 'Portada' })
      .click();
    const title = page.getByLabel('Título', { exact: true });
    // Descartar vuelve a lo guardado.
    await title.fill('Un cambio que no quiero');
    await page.getByRole('button', { name: 'Descartar…' }).click();
    await expectAccessible(page, 'diálogo descartar');
    await dialog(page).getByRole('button', { name: 'Volver a lo guardado' }).click();
    await expect(title).toHaveValue('Viaja con Ribera');
    await expect(page.getByText('Sin cambios pendientes')).toBeVisible();
    await title.fill('Temporada de creciente');
    await page.getByRole('button', { name: 'Publicar…' }).click();
    await expect(dialog(page).getByText('Portada: título «Temporada de creciente».')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Guardar y publicar la versión 2' }).click();
    await expect(dialog(page).getByText(/Versión 2 publicada/)).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Volver al editor' }).click();

    await page.getByRole('link', { name: 'Historial' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Historial del sitio' })).toBeVisible();
    const items = page.getByRole('list', { name: 'Versiones' }).getByRole('listitem');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('Publicada');
    await expect(items.nth(0)).toContainText('por Gerencia E2E');
    await expect(items.nth(1)).toContainText('Anterior');
    await expectAccessible(page, 'historial');
    if (CAPTURAS) await capture(page, 'historial');

    await page.getByRole('button', { name: 'Restaurar la versión 1' }).click();
    await expect(dialog(page).getByRole('heading', { name: '¿Restaurar la versión 1?' })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Restaurar y publicar' }).click();
    await expect(page.getByText('Versión 1 restaurada como versión 3')).toBeVisible();
    await expect(items).toHaveCount(3);

    await page.goto(hostUrl(HOST));
    await expect(page.getByRole('heading', { level: 1, name: 'Viaja con Ribera' })).toBeVisible();
  });

  test('móvil: el editor y el historial caben en 390 px y el menú del panel se abre', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(hostUrl(HOST, '/panel/sitio'));
    await expect(page.getByRole('heading', { level: 1, name: 'Mi sitio' })).toBeVisible();
    await expectNoHorizontalScroll(page, 'editor en móvil');
    await expectAccessible(page, 'editor en móvil');
    await page.getByRole('button', { name: 'Menú' }).click();
    await expect(page.getByRole('navigation', { name: 'Secciones del panel' })).toBeVisible();
    await page.goto(hostUrl(HOST, '/panel/sitio/historial'));
    await expectNoHorizontalScroll(page, 'historial en móvil');
  });
});
