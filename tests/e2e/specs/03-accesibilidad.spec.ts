import { expect, test } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll } from '../support/a11y';

/**
 * Modo oscuro (proyecto «oscuro») y móvil de 390 px (proyecto «movil»): cada pantalla y un diálogo pasan axe
 * (WCAG 2.1 AA, contraste incluido) y no desbordan en horizontal. Usa los datos que dejó el recorrido.
 */
test('login sin sesión', async ({ browser }, info) => {
  const ctx = await browser.newContext({ ...info.project.use, storageState: undefined });
  const page = await ctx.newPage();
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Inicia sesión' })).toBeVisible();
  await expectAccessible(page, 'login');
  await expectNoHorizontalScroll(page, 'login');
  await ctx.close();
});

test('pantallas del panel y un diálogo', async ({ page }) => {
  for (const [path, heading] of [
    ['/empresas', 'Empresas'],
    ['/empresas/nueva', 'Nueva empresa'],
    ['/planes', 'Planes'],
    ['/staff', 'Staff de YEBO'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await expectAccessible(page, path);
    await expectNoHorizontalScroll(page, path);
  }

  await page.goto('/empresas');
  await page.locator('main').getByRole('link', { name: 'Naviera Ucayali' }).click();
  await expect(page.getByRole('heading', { name: 'Naviera Ucayali', level: 1 })).toBeVisible();
  const base = page.url().split('?')[0];
  for (const tab of ['facturacion', 'resumen', 'soporte', 'modulos', 'historial']) {
    await page.goto(`${base}?seccion=${tab}`);
    await expect(
      page.locator('nav[aria-label="Secciones de la empresa"] [aria-current="page"]'),
    ).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectAccessible(page, `ficha · ${tab}`);
    await expectNoHorizontalScroll(page, `ficha · ${tab}`);
  }

  await page.getByRole('button', { name: 'Invitar a la empresa' }).click();
  await expect(
    page.locator('dialog[open]').getByRole('heading', { name: 'Invitar a Naviera Ucayali' }),
  ).toBeVisible();
  await expectAccessible(page, 'diálogo invitar a la empresa');
  await expectNoHorizontalScroll(page, 'diálogo invitar a la empresa');
});

test('menú del panel en móvil: abrir, navegar y cerrar con Esc', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) >= 1024, 'solo en pantallas estrechas');
  await page.goto('/empresas');
  const toggle = page.getByRole('button', { name: 'Menú' });
  const nav = page.getByRole('navigation', { name: 'Secciones del panel' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(nav).toBeHidden();
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Cerrar menú' })).toHaveAttribute('aria-expanded', 'true');
  for (const name of ['Empresas', 'Planes', 'Staff de YEBO']) {
    await expect(nav.getByRole('link', { name })).toBeInViewport();
  }
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
  await expectAccessible(page, 'menú móvil abierto');
  await expectNoHorizontalScroll(page, 'menú móvil abierto');
  // Navegar cierra el menú.
  await nav.getByRole('link', { name: 'Planes' }).click();
  await expect(page.getByRole('heading', { name: 'Planes', level: 1 })).toBeVisible();
  await expect(nav).toBeHidden();
  // Esc lo cierra y devuelve el foco al botón.
  await page.getByRole('button', { name: 'Menú' }).click();
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();
  await expect(page.getByRole('button', { name: 'Menú' })).toBeFocused();
});
