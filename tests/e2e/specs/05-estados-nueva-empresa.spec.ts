import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Solo con YEBO_E2E_CAPTURAS=1: el formulario «Nueva empresa» en sus estados (vacío, con errores y rellenado)
 * a 390, 1024 y 1440 px, en claro y en oscuro, como PNG en tests/e2e/capturas/ (revisión con Impeccable).
 */
test.skip(!process.env.YEBO_E2E_CAPTURAS, 'solo con YEBO_E2E_CAPTURAS=1');

test('estados del formulario de nueva empresa', async ({ browser }, info) => {
  mkdirSync('capturas', { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [390, 1024, 1440]) {
      const ctx = await browser.newContext({
        ...info.project.use,
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await ctx.newPage();
      await page.goto('/empresas/nueva');
      await expect(page.getByRole('heading', { name: 'Nueva empresa', level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const shot = (state: string) =>
        page.screenshot({ path: `capturas/nueva-${scheme}-${width}-${state}.png`, fullPage: true });
      await shot('vacio');
      await page.getByRole('button', { name: 'Dar de alta' }).click();
      await shot('errores');
      await page.getByLabel('Nombre comercial').fill('Empresa de Transportes Turismo Selva Central');
      await page.getByLabel('Razón social').fill('Empresa de Transportes Turismo Selva Central S.R.L.');
      await page.getByLabel('Número').fill('20512345678');
      await page
        .getByRole('group', { name: 'terrestre' })
        .getByRole('checkbox', { name: 'pasajeros' })
        .check();
      await page
        .getByRole('group', { name: 'terrestre' })
        .getByRole('checkbox', { name: 'encomiendas' })
        .check();
      await shot('relleno');
      await ctx.close();
    }
  }
});
