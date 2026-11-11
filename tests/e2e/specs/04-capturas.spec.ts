import { expect, test } from '@playwright/test';
import { capture } from '../support/capture';

/**
 * Capturas para la revisión de Impeccable (Fase 4.7c), solo con YEBO_E2E_CAPTURAS=1: cada pantalla renderizada,
 * con sus estilos incrustados, en tests/e2e/capturas/*.html (ignorado por git). El detector de Impeccable necesita
 * la página ya renderizada para las reglas de contraste, tamaño de texto y maquetación, y el panel exige sesión.
 */
test.skip(!process.env.YEBO_E2E_CAPTURAS, 'solo con YEBO_E2E_CAPTURAS=1');

test('capturas del panel', async ({ page, browser }, info) => {
  const anon = await browser.newContext({ ...info.project.use, storageState: undefined });
  const login = await anon.newPage();
  await login.goto('/login');
  await capture(login, 'login');
  await anon.close();

  for (const [path, name] of [
    ['/empresas', 'empresas'],
    ['/empresas/nueva', 'nueva-empresa'],
    ['/planes', 'planes'],
    ['/staff', 'staff'],
  ] as const) {
    await page.goto(path);
    await capture(page, name);
  }
  await page.goto('/empresas');
  await page.locator('main').getByRole('link', { name: 'Naviera Ucayali' }).click();
  await expect(page.getByRole('heading', { name: 'Naviera Ucayali', level: 1 })).toBeVisible();
  const base = page.url().split('?')[0];
  for (const tab of ['facturacion', 'resumen', 'soporte', 'modulos', 'historial']) {
    await page.goto(`${base}?seccion=${tab}`);
    await capture(page, `ficha-${tab}`);
  }
  await page.getByRole('button', { name: 'Invitar a la empresa' }).click();
  await capture(page, 'dialogo-invitar');
});
