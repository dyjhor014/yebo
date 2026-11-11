import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expectAccessible } from '../support/a11y';
import { E2E } from '../support/env';
import { freshCode } from '../support/totp';

/**
 * Acceso del staff (Fase 4.1 + 4.7a): sin sesión se va al login; contraseña; activación obligatoria de la
 * verificación en dos pasos con la clave que muestra la pantalla; cerrar sesión; y un segundo acceso con código.
 * Deja la sesión en .auth/staff.json para los demás recorridos.
 */
test('login, activación de la MFA, cierre de sesión y nuevo acceso con código', async ({ page }) => {
  await page.goto('/empresas');
  await expect(page).toHaveURL(/\/login\?volver=%2Fempresas$/);
  await expect(page.getByRole('heading', { name: 'Inicia sesión' })).toBeVisible();
  await expectAccessible(page, 'login');

  // Vacío y contraseña incorrecta: avisos sin revelar si el correo existe.
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.locator('main').getByRole('alert')).toHaveText(
    /Escribe tu correo de YEBO y tu contraseña/,
  );
  await page.getByLabel('Correo de YEBO').fill(E2E.staffEmail);
  await page.getByLabel('Contraseña', { exact: true }).fill('no-es-la-contraseña');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.locator('main').getByRole('alert')).toBeVisible();
  await expectAccessible(page, 'login con error');

  await page.getByLabel('Contraseña', { exact: true }).fill(E2E.staffPassword);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Activa la verificación en dos pasos' })).toBeVisible();
  await expect(page.getByText('Esta clave NO se escribe aquí')).toBeVisible();
  const key = (await page.locator('code').first().innerText()).replace(/\s/g, '');
  expect(key).toMatch(/^[A-Z2-7]{16,}$/);
  await expectAccessible(page, 'activación de la MFA');

  // Formato y código erróneo.
  const code = page.getByLabel('Código de 6 dígitos que muestra la app');
  await expect(code).toBeFocused();
  await code.fill('12');
  await page.getByRole('button', { name: 'Activar y entrar' }).click();
  await expect(page.getByText('El código tiene 6 dígitos.')).toBeVisible();
  const first = await freshCode(key);
  await code.fill(first.code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Activar y entrar' }).click();
  await expect(page.locator('main').getByRole('alert')).toBeVisible();

  await code.fill((await freshCode(key)).code);
  const activated = Math.floor(Date.now() / 30_000);
  await page.getByRole('button', { name: 'Activar y entrar' }).click();
  await expect(page).toHaveURL(/\/empresas$/);
  await expect(page.getByRole('heading', { name: 'Empresas', level: 1 })).toBeVisible();
  await expect(page.getByText(`${E2E.staffName}`)).toBeVisible();
  await expect(page.getByText('Superadmin · MFA activa')).toBeVisible();

  // Cerrar sesión: la sesión deja de valer.
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/empresas');
  await expect(page).toHaveURL(/\/login\?volver=/);

  // Segundo acceso: ahora pide el código (no la activación). Un código ya usado no vale: se espera al siguiente.
  await page.getByLabel('Correo de YEBO').fill(E2E.staffEmail);
  await page.getByLabel('Contraseña', { exact: true }).fill(E2E.staffPassword);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Verificación en dos pasos' })).toBeVisible();
  await page.getByLabel('Código de 6 dígitos').fill((await freshCode(key, activated)).code);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/empresas$/);

  mkdirSync('.auth', { recursive: true });
  writeFileSync('.auth/totp.txt', key);
  await page.context().storageState({ path: '.auth/staff.json' });
});
