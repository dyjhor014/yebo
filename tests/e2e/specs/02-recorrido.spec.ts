import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from '../support/a11y';
import { apiPost, seedPlan } from '../support/api';
import { limaDay, seedOverdueInvoice } from '../support/db';

/**
 * Recorrido de la maqueta 4.7 v2 aprobada, de punta a punta, con axe (WCAG 2.1 AA) en cada pantalla y diálogo:
 * empresas por urgencia y filtros, alta de empresa, ficha (trayecto, cobro y anulación, acciones y pestañas),
 * invitaciones (empresa y staff, con «Copiar» y la confirmación al cerrar sin copiar), planes y staff.
 */
test.describe.configure({ mode: 'serial' });

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const human = (iso: string) =>
  `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const main = (page: Page) => page.locator('main');
const dialog = (page: Page) => page.locator('dialog[open]');

let tenantId = '';
let plans: { v1: string; v2: string };

test('empresas: vacía, alta de empresa con errores y con la invitación del primer administrador', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/empresas');
  plans = await seedPlan(page);
  await expect(
    main(page).getByText('Aún no hay empresas. Da de alta la primera con «Nueva empresa».'),
  ).toBeVisible();
  await expect(page.locator('nav[aria-label="Secciones del panel"] a[aria-current="true"]')).toHaveText(
    'Empresas',
  );
  await expectAccessible(page, 'empresas vacía');

  await main(page).getByRole('link', { name: 'Nueva empresa' }).click();
  await expect(page.getByRole('heading', { name: 'Nueva empresa', level: 1 })).toBeVisible();
  // Todo el formulario cabe en 1440×900 sin desplazar (revisión del responsable, 2026-11-10).
  const submitBox = await page.getByRole('button', { name: 'Dar de alta' }).boundingBox();
  expect(submitBox && submitBox.y + submitBox.height).toBeLessThanOrEqual(900);
  await page.getByRole('button', { name: 'Dar de alta' }).click();
  for (const msg of [
    'Escribe el nombre comercial.',
    'Escribe la razón social.',
    'El RUC tiene 11 dígitos.',
    'Elige al menos un servicio.',
  ]) {
    await expect(main(page).getByText(msg)).toBeVisible();
  }
  // El foco va al primer campo con error; sin nombre comercial no se repite el error del subdominio.
  await expect(page.getByLabel('Nombre comercial')).toBeFocused();
  await expect(main(page).getByText('De 3 a 40 letras minúsculas')).toHaveCount(0);
  await expectAccessible(page, 'nueva empresa con errores');

  await page.getByLabel('Nombre comercial').fill('Naviera Ucayali');
  await expect(page.getByLabel('Subdominio')).toHaveValue('naviera-ucayali');
  await expect(main(page).getByText('.yebo.localhost', { exact: true })).toBeVisible();
  await expect(main(page).getByText('sin prueba: empieza «Al día»', { exact: false })).toBeVisible();
  await page.getByLabel('Razón social').fill('Naviera Ucayali S.A.C.');
  await page.getByLabel('Número').fill('20601234507');
  const river = page.getByRole('group', { name: 'fluvial' });
  await river.getByRole('checkbox', { name: 'pasajeros' }).check();
  await river.getByRole('checkbox', { name: 'carga' }).check();
  await page
    .getByLabel('Correo del primer administrador (opcional)')
    .fill('administracion@naviera-ucayali.pe');
  await page.getByRole('button', { name: 'Dar de alta' }).click();

  await expect(page.getByRole('heading', { name: 'Naviera Ucayali ya está dada de alta' })).toBeVisible();
  await expect(
    main(page).getByRole('status').filter({ hasText: 'naviera-ucayali.yebo.localhost ya resuelve' }),
  ).toBeVisible();
  await expectAccessible(page, 'empresa dada de alta con enlace');
  // «Listo» sin copiar pide confirmación; tras copiar, cierra y lleva a la ficha.
  await page.getByRole('button', { name: 'Listo' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('¿Cerrar sin copiar el enlace?');
  await page.getByRole('button', { name: 'Volver y copiar' }).click();
  await page.getByRole('button', { name: 'Copiar enlace' }).click();
  await expect(page.getByRole('button', { name: 'Copiado ✓' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /^https?:\/\/cuentas\.yebo\.localhost.*invitacion/,
  );
  await page.getByRole('button', { name: 'Listo' }).click();
  await expect(page).toHaveURL(/\/empresas\/[0-9a-f-]{36}$/);
  tenantId = page.url().split('/').pop()!;
});

test('lista por urgencia, próximo hito y filtros (con una factura vencida)', async ({ page }) => {
  await page.goto('/empresas');
  await apiPost(page, '/api/v1/platform/tenants', {
    slug: 'transportes-oriente',
    legalName: 'Transportes del Oriente S.A.C.',
    tradeName: 'Transportes del Oriente',
    taxIdType: 'RUC',
    taxId: '20509876541',
    planVersionId: plans.v1,
    services: [{ modality: 'LAND', service: 'PASSENGER' }],
  });
  await seedOverdueInvoice(tenantId);
  await page.reload();

  const rows = main(page).locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Naviera Ucayali');
  await expect(rows.nth(0)).toContainText('Pago vencido');
  await expect(rows.nth(0)).toContainText(`Se suspende el ${human(limaDay(7))}`);
  await expect(rows.nth(0)).toContainText('S/ 204.00');
  await expect(rows.nth(0)).toContainText('Fluvial · pasajeros y carga');
  await expect(rows.nth(1)).toContainText('Transportes del Oriente');
  await expect(rows.nth(1)).toContainText('Al día');

  const attention = main(page).getByRole('button', { name: /Pago vencido o suspendidas/ });
  await expect(attention).toContainText('Saldo pendiente: S/ 204.00');
  await attention.click();
  await expect(attention).toHaveAttribute('aria-pressed', 'true');
  await expect(main(page).getByRole('status').filter({ hasText: 'de 2 empresas' })).toContainText(
    '1 de 2 empresas',
  );
  await expect(rows).toHaveCount(1);
  await expectAccessible(page, 'empresas filtradas');
  await main(page).getByRole('button', { name: 'Quitar filtro' }).click();
  await expect(rows).toHaveCount(2);
});

test('ficha: trayecto y «Registrar pago» (errores, parcial, anulación y pago total)', async ({ page }) => {
  await page.goto('/empresas');
  await main(page).getByRole('link', { name: 'Naviera Ucayali' }).click();
  await expect(page.getByRole('heading', { name: 'Naviera Ucayali', level: 1 })).toBeVisible();
  await expect(page.locator('nav[aria-label="Ruta"] [aria-current="page"]')).toHaveText('Naviera Ucayali');
  const trip = page.getByRole('region', { name: 'Trayecto de la empresa' });
  await expect(trip).toContainText(`Se suspende el ${human(limaDay(7))} si no se regulariza`);
  await expect(trip.locator('li[aria-current="step"]')).toContainText('Pago vencido');
  await expect(page.locator('nav[aria-label="Secciones de la empresa"] [aria-current="page"]')).toHaveText(
    'Facturación y consumo',
  );
  await expectAccessible(page, 'ficha · facturación');

  const form = page.getByRole('region', { name: 'Registrar pago' });
  const amount = form.getByLabel('Importe en soles');
  await expect(amount).toHaveValue('204.00');
  await amount.fill('205');
  await expect(form.getByRole('status')).toHaveText(
    'Supera el saldo pendiente de S/ 204.00. Registra como mucho ese importe.',
  );
  await form.getByLabel('Fecha del pago').fill(limaDay(1));
  await form.getByRole('button', { name: 'Registrar pago' }).click();
  await expect(amount).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByText('La fecha del pago no puede ser futura.')).toBeVisible();
  await expect(form.getByText('Escribe el n.º de operación o de recibo.')).toBeVisible();
  await expectAccessible(page, 'registrar pago con errores');

  await form.getByLabel('Fecha del pago').fill(limaDay(0));
  await amount.fill('100,50');
  await expect(form.getByText('Se registrará S/ 100.50.')).toBeVisible();
  await expect(form.getByRole('status')).toHaveText(
    `Quedarán S/ 103.50 pendientes: la empresa sigue con pago vencido y se suspende el ${human(limaDay(7))} si no se regulariza.`,
  );
  await form.getByLabel('N.º de operación o de recibo').fill('OP-100');
  await form.getByRole('button', { name: 'Registrar pago' }).click();
  await expect(main(page).getByRole('status').filter({ hasText: 'Pago registrado' })).toContainText(
    'Saldo de la factura: S/ 103.50.',
  );

  // Anular el pago parcial: motivo obligatorio; repone el saldo.
  await main(page)
    .getByRole('button', { name: /^Anular el pago de S\/ 100\.50/ })
    .click();
  await expect(dialog(page).getByRole('heading', { name: 'Anular este pago' })).toBeVisible();
  await expectAccessible(page, 'diálogo anular pago');
  await dialog(page).getByRole('button', { name: 'Anular pago' }).click();
  await expect(dialog(page).getByText('Escribe el motivo (al menos 3 caracteres).')).toBeVisible();
  await dialog(page).getByLabel('Motivo').fill('Registrado por error');
  await dialog(page).getByRole('button', { name: 'Anular pago' }).click();
  await expect(main(page).getByRole('status').filter({ hasText: 'Pago anulado' })).toContainText(
    'Saldo de la factura: S/ 204.00.',
  );
  await expect(main(page).getByText('Registrado por error')).toBeVisible();

  // Pago total: la empresa vuelve a «Al día» en ese momento.
  await expect(form.getByLabel('Importe en soles')).toHaveValue('204.00');
  await expect(form.getByRole('status')).toHaveText(
    'Con este pago no queda saldo vencido: la empresa vuelve a «Al día» en ese momento.',
  );
  await form.getByLabel('Método').selectOption('CASH');
  await form.getByLabel('N.º de operación o de recibo').fill('REC-204');
  await form.getByRole('button', { name: 'Registrar pago' }).click();
  await expect(main(page).getByRole('status').filter({ hasText: 'Pago registrado' })).toContainText(
    'La empresa vuelve a «Al día».',
  );
  await expect(trip.locator('li[aria-current="step"]')).toContainText('Al día');
  await expect(main(page).getByText('No hay facturas con saldo pendiente.')).toBeVisible();
});

test('ficha: invitar a la empresa (errores, cerrar sin copiar con Esc, copiar)', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/empresas/${tenantId}`);
  await page.getByRole('button', { name: 'Invitar a la empresa' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Invitar a Naviera Ucayali' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Crear invitación' }).click();
  await expect(dialog(page).getByText('Escribe un correo válido.')).toBeVisible();
  await expect(dialog(page).getByText('Elige al menos un rol.')).toBeVisible();
  await expectAccessible(page, 'diálogo invitar a la empresa con errores');
  await dialog(page).getByLabel('Correo de la persona').fill('jefa.finanzas@naviera-ucayali.pe');
  await dialog(page)
    .getByRole('checkbox', { name: /Administrador/ })
    .check();
  await dialog(page).getByRole('button', { name: 'Crear invitación' }).click();
  await expect(dialog(page).getByRole('status').first()).toContainText('jefa.finanzas@naviera-ucayali.pe');
  await expect(dialog(page)).toContainText('como Administrador de Naviera Ucayali');
  await page.keyboard.press('Escape');
  await expect(dialog(page).getByRole('alertdialog')).toContainText('¿Cerrar sin copiar el enlace?');
  await expectAccessible(page, 'confirmación de cerrar sin copiar');
  await dialog(page).getByRole('button', { name: 'Volver y copiar' }).click();
  await dialog(page).getByRole('button', { name: 'Copiar enlace' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Copiado ✓' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Listo' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('ficha: cambiar plan (upgrade), acceso de soporte y pestañas', async ({ page }) => {
  await page.goto(`/empresas/${tenantId}`);
  await page.getByRole('button', { name: 'Cambiar plan' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Cambiar plan' })).toBeVisible();
  await dialog(page).getByLabel('Plan nuevo').selectOption(plans.v2);
  await dialog(page).getByRole('button', { name: 'Cambiar plan' }).click();
  await expect(dialog(page).getByText('Escribe el motivo (al menos 3 caracteres).')).toBeVisible();
  await expectAccessible(page, 'diálogo cambiar plan');
  await dialog(page).getByLabel('Motivo').fill('Necesita más usuarios incluidos');
  await dialog(page).getByRole('button', { name: 'Cambiar plan' }).click();
  await expect(dialog(page).getByRole('status')).toContainText(
    `Upgrade aplicado desde el ${human(limaDay(0))}`,
  );
  await dialog(page).getByRole('button', { name: 'Listo' }).click();
  await expect(main(page).getByRole('region', { name: 'Plan y período' })).toContainText(
    'Básico E2E (versión 2)',
  );

  await page.getByRole('button', { name: 'Abrir acceso de soporte' }).click();
  await dialog(page).getByLabel('Motivo').fill('Ticket 1234: revisar la configuración de rutas');
  await expectAccessible(page, 'diálogo abrir acceso de soporte');
  await dialog(page).getByRole('button', { name: 'Abrir acceso' }).click();
  await expect(dialog(page).getByRole('status')).toContainText('Acceso abierto');
  await dialog(page).getByRole('button', { name: 'Listo' }).click();

  const tabs = page.locator('nav[aria-label="Secciones de la empresa"]');
  await tabs.getByRole('link', { name: 'Accesos de soporte' }).click();
  await expect(page).toHaveURL(/seccion=soporte/);
  const grant = main(page).getByRole('region', { name: 'Accesos de soporte' }).locator('li').first();
  await expect(grant).toContainText('Ticket 1234');
  await expect(grant).toContainText('Activo');
  await expect(grant.getByRole('button', { name: 'Entrar a la empresa' })).toBeVisible();
  await expectAccessible(page, 'pestaña accesos de soporte');
  await grant.getByRole('button', { name: 'Revocar' }).click();
  await expect(grant).toContainText('Revocado');

  await tabs.getByRole('link', { name: 'Módulos y excepciones' }).click();
  const ops = main(page).getByRole('region', { name: 'Excepciones de operación' });
  await ops.getByLabel('Motivo').fill('Alta de choferes antes de regularizar');
  await ops.getByRole('button', { name: 'Crear excepción' }).click();
  await expect(ops).toContainText('Permite dar de alta usuarios');
  await expectAccessible(page, 'pestaña módulos y excepciones');
  await ops.getByRole('button', { name: 'Terminar' }).click();
  await expect(ops).toContainText('terminada el');

  await tabs.getByRole('link', { name: 'Historial' }).click();
  await expect(main(page).getByRole('region', { name: 'Cambios de estado' })).toContainText(
    'Pago vencido → Al día',
  );
  await expectAccessible(page, 'pestaña historial');

  await tabs.getByRole('link', { name: 'Resumen' }).click();
  await expect(main(page).getByRole('region', { name: 'Datos de la empresa' })).toContainText(
    'RUC 20601234507',
  );
  await expectAccessible(page, 'pestaña resumen');
});

test('ficha: cambiar estado (cancelar exige el nombre; pasar a pago vencido con motivo)', async ({
  page,
}) => {
  await page.goto(`/empresas/${tenantId}`);
  await page.getByRole('button', { name: 'Suspender o cancelar…' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Cambiar el estado de la empresa' })).toBeVisible();
  await dialog(page)
    .getByRole('radio', { name: /Cancelada/ })
    .check();
  await dialog(page).getByLabel('Motivo').fill('Prueba de confirmación');
  await dialog(page).getByRole('button', { name: 'Pasar a «Cancelada»' }).click();
  await expect(dialog(page).getByText('Escribe «Naviera Ucayali» para confirmar.')).toBeVisible();
  await expectAccessible(page, 'diálogo cambiar estado (cancelar)');
  await dialog(page)
    .getByRole('radio', { name: /Pago vencido/ })
    .check();
  await dialog(page).getByRole('button', { name: 'Pasar a «Pago vencido»' }).click();
  await expect(main(page).getByRole('status').filter({ hasText: 'La empresa pasó a' })).toContainText(
    '«Pago vencido»',
  );
  await expect(
    page.getByRole('region', { name: 'Trayecto de la empresa' }).locator('li[aria-current="step"]'),
  ).toContainText('Pago vencido');
});

test('staff de YEBO: invitar (dominio, Superadmin con confirmación) y planes', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/staff');
  await expect(page.getByRole('heading', { name: 'Staff de YEBO', level: 1 })).toBeVisible();
  await expectAccessible(page, 'staff');
  await main(page).getByRole('button', { name: 'Invitar al staff' }).click();
  await dialog(page).getByLabel('Nombre completo').fill('Lucía Torres');
  await dialog(page).getByLabel('Correo de YEBO').fill('lucia@gmail.com');
  await expect(dialog(page).getByText('El staff solo admite correos @yebo.pe.')).toBeVisible();
  await dialog(page).getByLabel('Correo de YEBO').fill('lucia.torres@yebo.pe');
  await dialog(page)
    .getByRole('radio', { name: /Superadmin/ })
    .check();
  await dialog(page).getByRole('button', { name: 'Crear invitación' }).click();
  await expect(dialog(page).getByText('Confirma el acceso total o elige otro rol.')).toBeVisible();
  await expectAccessible(page, 'diálogo invitar al staff (superadmin)');
  await dialog(page)
    .getByRole('checkbox', { name: /acceso total/ })
    .check();
  await dialog(page).getByRole('button', { name: 'Crear invitación' }).click();
  await expect(dialog(page).getByRole('status').first()).toContainText('Superadmin (acceso total)');
  await dialog(page).getByRole('button', { name: 'Copiar enlace' }).click();
  await dialog(page).getByRole('button', { name: 'Listo' }).click();
  await expect(main(page).getByRole('region', { name: 'Miembros del staff' })).toContainText('Lucía Torres');
  await expect(main(page).getByRole('region', { name: 'Miembros del staff' })).toContainText(
    'sin configurar la contraseña',
  );

  await page.locator('nav[aria-label="Secciones del panel"]').getByRole('link', { name: 'Planes' }).click();
  await expect(main(page).getByRole('region', { name: /Básico E2E/ })).toContainText(
    'Versión 2 · S/ 149.00 al mes',
  );
  await expectAccessible(page, 'planes');
});
