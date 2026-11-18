import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from '../support/a11y';
import { apiPost } from '../support/api';
import { CAPTURAS, capture } from '../support/capture';
import { withDb } from '../support/db';
import { E2E, hostUrl } from '../support/env';
import { followHttpRedirects } from '../support/tenant-login';

/**
 * Criterio de aceptación de la Fase 6 (etapa 6.6), mitad del editor: una empresa fluvial y terrestre construye con el
 * editor, desde planos en blanco, una lancha con camarotes (con camas), zona libre, cubierta de carga y bodega, y un
 * bus de dos pisos (16 + 40 asientos) con su bodega de equipaje, y una camioneta pickup 4×4 con asientos de
 * cabina (clase CABINA) y la tolva partida en pasajeros y carga. Publica los tres, los asigna a sus vehículos desde
 * Flota y la capacidad que queda materializada en la base es la esperada. Las mismas cifras que la integración phase6-criterion.
 */
test.describe.configure({ mode: 'serial' });

const SLUG = 'rio-y-carretera';
const HOST = `${SLUG}.${E2E.baseDomain}`;
const ADMIN_EMAIL = `flota@${SLUG}.pe`;
const PASSWORD = 'del-rio-a-la-carretera-2026';
const LANCHA = 'Lancha Amazonas E2E';
const BUS = 'Bus dos pisos E2E';
const PICKUP = 'Pickup 4x4 E2E';

const dialog = (page: Page) => page.locator('dialog[open]');
const saved = (page: Page) => expect(page.getByText(/^Guardado en el borrador/)).toBeVisible();
const crearZona = (page: Page) => page.getByRole('group', { name: 'Crear zona' });

/** «Nuevo plano» en blanco, con su modalidad y las medidas del piso 1. */
async function nuevoPlano(
  page: Page,
  name: string,
  modality: 'Fluvial' | 'Terrestre',
  largo: string,
  ancho: string,
  escala: '25' | '50' = '50',
) {
  await page.goto(hostUrl(HOST, '/panel/planos'));
  await expect(page.getByRole('heading', { level: 1, name: 'Planos' })).toBeVisible();
  await page.getByRole('button', { name: 'Nuevo plano' }).click();
  const d = dialog(page);
  await d.getByRole('button', { name: modality }).click();
  await expect(d.getByRole('button', { name: modality })).toHaveAttribute('aria-pressed', 'true');
  await d.getByRole('radio', { name: /En blanco/ }).check();
  await d.getByLabel('Nombre', { exact: true }).fill(name);
  await d.getByLabel('Largo del piso 1 (m)').fill(largo);
  await d.getByLabel('Ancho (m)').fill(ancho);
  await d.getByLabel('Escala de la grilla').selectOption(escala);
  await d.getByRole('button', { name: 'Crear plano' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: `${name} · borrador de la versión 1` }),
  ).toBeVisible();
}

/** «Crear zona» del tipo y largo dados en el piso que se ve; devuelve tras el aviso del editor. */
async function zona(page: Page, tipo: string, largo: string, aviso: string) {
  await crearZona(page).getByRole('combobox', { name: 'Tipo', exact: true }).selectOption({ label: tipo });
  await crearZona(page).getByLabel('Largo (m)').fill(largo);
  await crearZona(page)
    .getByRole('button', { name: /^Crear la zona en / })
    .click();
  await expect(page.getByText(aviso)).toBeVisible();
}

/** Un campo numérico del editor (capacidad, aforo): se escribe y se confirma con Enter. */
async function numero(page: Page, label: string | RegExp, value: string) {
  const input = page.getByRole('textbox', { name: label, exact: true });
  await input.fill(value);
  await input.press('Enter');
}

async function publicar(page: Page, resumen: string) {
  await saved(page);
  await page.getByRole('button', { name: 'Publicar versión 1…' }).click();
  const d = page.getByRole('dialog', { name: '¿Publicar la versión 1?' });
  await expect(d.getByText(resumen)).toBeVisible();
  await expectAccessible(page, `publicar ${resumen.slice(0, 7)}`);
  await d.getByRole('button', { name: 'Publicar la versión 1' }).click();
  await expect(page.getByText('Versión 1 publicada')).toBeAttached();
  await expect(page.getByText('Una versión publicada ya no cambia.')).toBeVisible();
}

test('preparación: empresa fluvial y terrestre, y su jefatura de flota registrada desde la invitación', async ({
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
    legalName: 'Río y Carretera S.A.C.',
    tradeName: 'Río y Carretera',
    taxIdType: 'RUC',
    taxId: '20609123452',
    planVersionId,
    services: [
      { modality: 'RIVER', service: 'PASSENGER' },
      { modality: 'RIVER', service: 'PARCEL' },
      { modality: 'RIVER', service: 'CARGO' },
      { modality: 'LAND', service: 'PASSENGER' },
      { modality: 'LAND', service: 'CARGO' },
    ],
    firstAdminEmail: ADMIN_EMAIL,
  })) as { firstAdminInvitation: { link: string } };
  await staff.close();

  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(hostUrl(E2E.hubHost, `/invitacion#${created.firstAdminInvitation.link.split('#')[1]}`));
  await admin.getByLabel('Tu nombre completo').fill('Jefatura de Flota E2E');
  await admin.getByLabel('Crea una contraseña').fill(PASSWORD);
  await admin.getByLabel('Repite la contraseña').fill(PASSWORD);
  await admin.getByRole('button', { name: 'Crear mi cuenta y aceptar' }).click();
  await expect(admin.getByRole('heading', { name: 'Ya formas parte de Río y Carretera' })).toBeVisible();
  await ctx.storageState({ path: '.auth/rio-carretera.json' });
  await ctx.close();
});

test.describe('con la sesión de la empresa', () => {
  test.use({ storageState: '.auth/rio-carretera.json', viewport: { width: 1440, height: 900 } });

  test('entrar al panel', async ({ page }) => {
    await followHttpRedirects(page);
    await page.goto(hostUrl(HOST, '/panel'));
    await page.getByRole('link', { name: 'Iniciar sesión' }).click();
    await expect(page).toHaveURL(/\/panel\//);
    await expect(
      page.getByRole('navigation', { name: 'Secciones del panel' }).getByRole('link', { name: 'Planos' }),
    ).toBeVisible();
    await page.context().storageState({ path: '.auth/rio-carretera.json' });
  });

  test('lancha: camarotes con camas, zona libre, cubierta de carga y bodega, construida en el editor', async ({
    page,
  }) => {
    await nuevoPlano(page, LANCHA, 'Fluvial', '16', '5');

    // Piso 1 (16 × 5 m): camarotes, zona libre y cubierta de carga, de proa a popa.
    await zona(page, 'Pasajeros: camarotes y camas', '6', 'Camarotes creada en Piso 1, de la fila 1 a la 12');
    await page.getByRole('group', { name: 'Camarotes y camas' }).getByLabel('Camas').selectOption('2');
    for (const code of ['C1', 'C2', 'C3']) {
      await page.getByRole('button', { name: 'Añadir camarote' }).click();
      await expect(page.getByText(new RegExp(`^Camarote ${code} de 2 camas en la `))).toBeVisible();
    }
    await zona(page, 'Zona libre', '4', 'Zona libre creada en Piso 1, de la fila 13 a la 20');
    await numero(page, 'Personas', '30');
    await zona(page, 'Cubierta de carga', '6', 'Cubierta de carga creada en Piso 1, de la fila 21 a la 32');
    await numero(page, 'Peso (kg)', '5000');
    await numero(page, 'Metros lineales', '10');

    // Piso 2: la bodega de encomiendas.
    await page.getByRole('button', { name: 'Añadir piso' }).click();
    await page.getByLabel('Nombre del piso').fill('Bodega');
    await page.getByLabel('Nombre del piso').press('Enter');
    await expect(
      page.getByRole('tablist', { name: 'Pisos' }).getByRole('tab', { name: 'Bodega' }),
    ).toBeVisible();
    await zona(page, 'Bodega', '10', 'Bodega creada en Bodega, de la fila 1 a la 20');
    await numero(page, 'Peso (kg)', '2000');
    await numero(page, 'Volumen (m³)', '10');

    // El nombre del campo es solo su etiqueta; la ayuda se lee como descripción (aria-describedby).
    await expect(page.getByRole('textbox', { name: 'Aforo total', exact: true })).toHaveAccessibleDescription(
      /^Tope de personas a bordo/,
    );
    await numero(page, 'Aforo total', '36');
    const vende = page.getByRole('region', { name: 'Pisos, zonas y capacidad' });
    await expect(
      vende.getByText('Camarotes (6 camas en total)').locator('xpath=following-sibling::dd[1]'),
    ).toHaveText('3');
    await expect(
      vende.getByText('Personas en zonas libres').locator('xpath=following-sibling::dd[1]'),
    ).toHaveText('30');
    await expect(page.getByRole('heading', { name: 'Listo para publicar' })).toBeVisible();
    await expectAccessible(page, 'editor con la lancha construida');
    if (CAPTURAS) await capture(page, 'criterio-lancha');

    await publicar(
      page,
      '2 pisos: 0 asientos, 3 camarotes, 6 camas y 30 personas en zonas libres; aforo de 36.',
    );
  });

  test('bus de dos pisos: 16 + 40 asientos 2 + 2 y bodega de equipaje, construido en el editor', async ({
    page,
  }) => {
    await nuevoPlano(page, BUS, 'Terrestre', '12', '3');
    const pisos = page.getByRole('tablist', { name: 'Pisos' });

    // Piso 1: 4 filas (1A–4D).
    await zona(
      page,
      'Pasajeros: asientos y camarotes',
      '4',
      'Pasajeros creada en Piso 1, de la fila 1 a la 8',
    );
    await page.getByRole('spinbutton', { name: 'Filas' }).fill('4');
    await page.getByRole('button', { name: 'Añadir 4 filas 2 + 2' }).click();
    await expect(page.getByText('16 asientos en 4 filas 2 + 2 (filas 1 a 4)', { exact: true })).toBeVisible();

    // Piso 2: 10 filas que siguen la numeración (5A–14D).
    await page.getByRole('button', { name: 'Añadir piso' }).click();
    await expect(pisos.getByRole('tab', { name: 'Piso 2' })).toHaveAttribute('aria-selected', 'true');
    await zona(
      page,
      'Pasajeros: asientos y camarotes',
      '10',
      'Pasajeros 2 creada en Piso 2, de la fila 1 a la 20',
    );
    await page.getByRole('spinbutton', { name: 'Filas' }).fill('10');
    await page.getByRole('button', { name: 'Añadir 10 filas 2 + 2' }).click();
    await expect(
      page.getByText('40 asientos en 10 filas 2 + 2 (filas 5 a 14)', { exact: true }),
    ).toBeVisible();

    // La bodega de equipaje, como su propio piso.
    await page.getByRole('button', { name: 'Añadir piso' }).click();
    await page.getByLabel('Nombre del piso').fill('Bodega');
    await page.getByLabel('Nombre del piso').press('Enter');
    await expect(pisos.getByRole('tab', { name: 'Bodega' })).toBeVisible();
    await zona(page, 'Equipaje', '6', 'Equipaje creada en Bodega, de la fila 1 a la 12');
    await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill('Bodega de equipaje');
    await page.getByRole('textbox', { name: 'Nombre', exact: true }).press('Enter');
    await numero(page, 'Peso (kg)', '1500');
    await numero(page, 'Volumen (m³)', '8');
    await numero(page, 'Aforo total', '56');

    const vende = page.getByRole('region', { name: 'Pisos, zonas y capacidad' });
    await expect(
      vende.getByText('Asientos', { exact: true }).locator('xpath=following-sibling::dd[1]'),
    ).toHaveText('56');
    await expect(page.getByRole('heading', { name: 'Listo para publicar' })).toBeVisible();
    await expectAccessible(page, 'editor con el bus de dos pisos');
    if (CAPTURAS) await capture(page, 'criterio-bus');

    await publicar(
      page,
      '3 pisos: 56 asientos, 0 camarotes, 0 camas y 0 personas en zonas libres; aforo de 56.',
    );
  });

  test('pickup 4×4: asientos de cabina más caros y, en la tolva, pasajeros y carga, construida en el editor', async ({
    page,
  }) => {
    // 5,5 × 2 m con celdas de 25 cm: cabina de 3,5 m y tolva de 2 m, partida en pasajeros y carga.
    await nuevoPlano(page, PICKUP, 'Terrestre', '5.5', '2', '25');
    const nombre = page.getByRole('textbox', { name: 'Nombre', exact: true });
    const renombrar = async (v: string) => {
      await nombre.fill(v);
      await nombre.press('Enter');
    };

    await zona(
      page,
      'Pasajeros: asientos y camarotes',
      '3.5',
      'Pasajeros creada en Piso 1, de la fila 1 a la 14',
    );
    await renombrar('Cabina');
    for (const code of ['S1', 'S2', 'S3', 'S4']) {
      await page.getByRole('button', { name: 'Añadir un asiento individual' }).click();
      await expect(page.getByText(new RegExp(`^Asiento ${code} en la `))).toBeVisible();
      // El asiento nuevo queda elegido: su clase de precio, la de la cabina.
      const clase = page.getByRole('textbox', { name: 'Clase de precio (opcional)', exact: true });
      await clase.fill('CABINA');
      await clase.press('Enter');
      await expect(clase).toHaveValue('CABINA');
    }

    await zona(page, 'Zona libre', '1', 'Zona libre creada en Piso 1, de la fila 15 a la 18');
    await renombrar('Tolva · pasajeros');
    await numero(page, 'Personas', '4');
    // La zona también tiene su clase de precio: la tolva, más barata que la cabina.
    const claseZona = page.getByRole('textbox', { name: 'Clase de precio (opcional)', exact: true });
    await expect(claseZona).toHaveAccessibleDescription(/^Vacía: GENERAL\./);
    await claseZona.fill('tolva!');
    await claseZona.press('Enter');
    await expect(claseZona).toHaveAttribute('aria-invalid', 'true');
    await expect(claseZona).toHaveAccessibleDescription(/^Usa mayúsculas, números o guion bajo/);
    await claseZona.fill('tolva');
    await claseZona.press('Enter');
    await expect(page.getByText('Tolva · pasajeros: clase TOLVA')).toBeAttached();
    await expect(claseZona).not.toHaveAttribute('aria-invalid', 'true');
    await zona(page, 'Cubierta de carga', '1', 'Cubierta de carga creada en Piso 1, de la fila 19 a la 22');
    await renombrar('Tolva · carga');
    await numero(page, 'Peso (kg)', '600');
    await numero(page, 'Metros lineales', ''); // la tolva se mide en kg
    await numero(page, 'Aforo total', '8');

    const vende = page.getByRole('region', { name: 'Pisos, zonas y capacidad' });
    await expect(
      vende.getByText('Asientos', { exact: true }).locator('xpath=following-sibling::dd[1]'),
    ).toHaveText('4');
    await expect(
      vende.getByText('Personas en zonas libres').locator('xpath=following-sibling::dd[1]'),
    ).toHaveText('4');
    await expect(page.getByRole('heading', { name: 'Listo para publicar' })).toBeVisible();
    await expectAccessible(page, 'editor con la pickup');
    if (CAPTURAS) await capture(page, 'criterio-pickup');

    await publicar(
      page,
      '1 piso: 4 asientos, 0 camarotes, 0 camas y 4 personas en zonas libres; aforo de 8.',
    );
  });

  test('flota: cada vehículo recibe su plano publicado', async ({ page }) => {
    await page.goto(hostUrl(HOST, '/panel/flota'));
    await expect(page.getByRole('heading', { level: 1, name: 'Flota' })).toBeVisible();

    await page.getByRole('button', { name: 'Tipos de vehículo' }).click();
    const types = page.getByRole('dialog', { name: 'Tipos de vehículo' });
    for (const [modalidad, nombre] of [
      ['Fluvial', 'Lancha de pasajeros y carga'],
      ['Terrestre', 'Bus interprovincial'],
    ] as const) {
      await types.getByLabel('Modalidad').selectOption({ label: modalidad });
      await types.getByLabel('Nombre', { exact: true }).fill(nombre);
      await types.getByRole('button', { name: 'Crear tipo' }).click();
      await expect(types.getByText(nombre)).toBeVisible();
    }
    // La pickup, desde la sugerencia del catálogo de YEBO: rellena el nombre.
    await types.getByLabel('Modalidad').selectOption({ label: 'Terrestre' });
    await types.getByLabel('Sugerencia (opcional)').selectOption({ label: 'Camioneta pickup 4×4' });
    await expect(types.getByLabel('Nombre', { exact: true })).toHaveValue('Camioneta pickup 4×4');
    await types.getByRole('button', { name: 'Crear tipo' }).click();
    await expect(types.getByRole('list').getByText('Camioneta pickup 4×4', { exact: true })).toBeVisible();
    await types.getByRole('button', { name: 'Cerrar', exact: true }).click();

    for (const [code, nombre, tipo, placa, plano, planos] of [
      ['LANCHA-01', 'Amazonas I', 'Lancha de pasajeros y carga (fluvial)', 'IQ-54321-RC', LANCHA, 1],
      ['BUS-01', 'Carretera 1', 'Bus interprovincial (terrestre)', 'ABC-123', BUS, 2],
      ['PICKUP-01', 'Selva 4x4', 'Camioneta pickup 4×4 (terrestre)', 'XYZ-987', PICKUP, 2],
    ] as const) {
      await page.getByRole('button', { name: 'Nuevo vehículo' }).click();
      const v = page.getByRole('dialog', { name: 'Nuevo vehículo' });
      await v.getByLabel('Código').fill(code);
      await v.getByLabel('Nombre', { exact: true }).fill(nombre);
      await v.getByLabel('Tipo', { exact: true }).selectOption({ label: tipo });
      await v.getByLabel('Placa o matrícula').fill(placa);
      await v.getByRole('button', { name: 'Crear vehículo' }).click();
      await expect(page.getByText(`Vehículo ${code} guardado`)).toBeAttached();
      await expect(page.getByText('Sin plano asignado')).toBeVisible();

      await page.getByRole('button', { name: 'Asignar un plano…' }).click();
      const a = page.getByRole('dialog', { name: 'Asignar un plano' });
      // Solo se ofrecen los planos de su modalidad: la lancha, uno; los terrestres, el bus y la pickup.
      await expect(a.getByLabel('Plano y versión').locator('option')).toHaveCount(planos);
      await a.getByLabel('Plano y versión').selectOption({ label: `${plano} · versión 1` });
      await a.getByRole('button', { name: 'Asignar', exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByText('Vigente').first()).toBeVisible();
    }
    await expectAccessible(page, 'flota con los tres vehículos');
    if (CAPTURAS) await capture(page, 'criterio-flota');
  });

  test('la capacidad materializada del plano vigente de cada vehículo es la esperada', async () => {
    const vigente = (code: string) =>
      withDb(async (db) => {
        const { rows } = await db.query<{
          total: number;
          decks: number;
          seats: number;
          beds: number;
          cabins: number;
          sellable: number;
          rules: string[];
        }>(
          `SELECT v.total_persons AS total, v.decks,
                  (SELECT count(*)::int FROM layout_elements e WHERE e.layout_version_id = v.id AND e.kind = 'SEAT') AS seats,
                  (SELECT count(*)::int FROM layout_elements e WHERE e.layout_version_id = v.id AND e.kind = 'BED') AS beds,
                  (SELECT count(*)::int FROM layout_elements e WHERE e.layout_version_id = v.id AND e.kind = 'CABIN') AS cabins,
                  (SELECT count(*)::int FROM layout_elements e WHERE e.layout_version_id = v.id AND e.is_assignable) AS sellable,
                  (SELECT array_agg(z.kind::text || ' ' || r.dimension::text || ' ' || (r.capacity::numeric)::int::text
                                    ORDER BY z.kind::text, r.dimension::text)
                     FROM capacity_rules r JOIN layout_zones z ON z.id = r.zone_id
                    WHERE z.layout_version_id = v.id) AS rules
             FROM vehicles h
             JOIN vehicle_layout_assignments a ON a.vehicle_id = h.id
             JOIN layout_versions v ON v.id = a.layout_version_id
            WHERE h.code = $1 AND h.tenant_id = (SELECT id FROM tenants WHERE slug = $2)
              AND a.valid_from <= current_date AND (a.valid_to IS NULL OR a.valid_to > current_date)`,
          [code, SLUG],
        );
        return rows;
      });

    expect(await vigente('LANCHA-01')).toEqual([
      {
        total: 36,
        decks: 2,
        seats: 0,
        beds: 6,
        cabins: 3,
        sellable: 6,
        rules: [
          'CARGO_DECK LINEAR_M 10',
          'CARGO_DECK WEIGHT_KG 5000',
          'FREE_ZONE PERSONS 30',
          'HOLD VOLUME_M3 10',
          'HOLD WEIGHT_KG 2000',
        ],
      },
    ]);
    expect(await vigente('BUS-01')).toEqual([
      {
        total: 56,
        decks: 3,
        seats: 56,
        beds: 0,
        cabins: 0,
        sellable: 56,
        rules: ['LUGGAGE VOLUME_M3 8', 'LUGGAGE WEIGHT_KG 1500'],
      },
    ]);
    expect(await vigente('PICKUP-01')).toEqual([
      {
        total: 8,
        decks: 1,
        seats: 4,
        beds: 0,
        cabins: 0,
        sellable: 4,
        rules: ['CARGO_DECK WEIGHT_KG 600', 'FREE_ZONE PERSONS 4'],
      },
    ]);
    // Los asientos de la cabina, con su clase de precio; la tolva de pasajeros, con la de su zona.
    const zonas = await withDb(
      async (db) =>
        (
          await db.query<{ name: string; price: string | null }>(
            `SELECT z.name, z.price_class_code AS price
               FROM layout_zones z JOIN layout_versions v ON v.id = z.layout_version_id
               JOIN vehicle_layouts l ON l.id = v.layout_id
              WHERE l.name = $1 ORDER BY z.code`,
            [PICKUP],
          )
        ).rows,
    );
    expect(zonas).toEqual([
      { name: 'Tolva · carga', price: null },
      { name: 'Tolva · pasajeros', price: 'TOLVA' },
      { name: 'Cabina', price: null },
    ]);
    const clases = await withDb(
      async (db) =>
        (
          await db.query<{ code: string; price: string }>(
            `SELECT e.code, e.price_class_code AS price
               FROM layout_elements e JOIN layout_versions v ON v.id = e.layout_version_id
               JOIN vehicle_layouts l ON l.id = v.layout_id
              WHERE l.name = $1 AND e.is_assignable ORDER BY e.code`,
            [PICKUP],
          )
        ).rows,
    );
    expect(clases).toEqual(['S1', 'S2', 'S3', 'S4'].map((code) => ({ code, price: 'CABINA' })));
  });
});
