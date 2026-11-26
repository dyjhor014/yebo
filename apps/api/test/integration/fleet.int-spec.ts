/**
 * Fase 6.2 · Flota (data-dictionary §4; F6-Q3, F6-Q5). PostgreSQL, Redis y almacenamiento S3 (Garage) reales:
 * tipos de vehículo por modalidad, vehículos (código y placa únicos, modalidad heredada del tipo), documentos con
 * vencimiento (renovación como historia) y archivos privados comprobados por su contenido, con descarga autenticada.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import sharp from 'sharp';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { ObjectStorage } from '../../src/infrastructure/storage/object-storage';
import { PERMISSION_CODES } from '../../src/modules/access/permission-catalog';
import { SessionService } from '../../src/modules/identity/session.service';
import { RESET_TENANT_DATA, testBypassPool, testPool } from '../support/db';
import { STAFF_CSRF, seedPlatformSession } from '../support/platform-session';

const DB = 'yebo_test';
const ADMIN = 'admin.yebo.pe';
const HUB = 'cuentas.yebo.pe';
const CSRF = 'csrf-de-prueba-0123456789abcdef';
const PASSWORD = 'rios-claros-del-amazonas-2026';

type Company = { id: string; host: string; adminUserId: string };
type Method = 'get' | 'put' | 'post';

/** Hoy en Lima ± días, `AAAA-MM-DD` (la misma regla que la API: el calendario de la empresa). */
const day = (offset: number) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
};
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

describe('Fase 6.2 · flota', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let staff = '';
  let a: Company; // fluvial y terrestre
  let b: Company; // solo fluvial

  const http = () => request(app.getHttpServer());
  const asStaff = (method: 'get' | 'post', path: string, body?: object) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', staff);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  const cookie = async (c: Company, userId = c.adminUserId) => {
    const sessions = app.get(SessionService);
    const identity = (await sessions.createIdentitySession({ userId, authMethods: ['pwd'] })).id;
    const token = (await sessions.openTenantSession({ identitySessionId: identity, host: c.host }))
      .accessToken;
    return `__Host-yebo_at=${token}; __Host-yebo_csrf=${CSRF}`;
  };
  const as = async (c: Company, method: Method, path: string, body?: object, userId?: string) => {
    const session = await cookie(c, userId);
    const agent = http();
    let req = agent[method](path).set('Host', c.host).set('Cookie', session);
    if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
    return body ? req.send(body) : req;
  };
  const upload = async (c: Company, bytes: Buffer, type: string) =>
    http()
      .post('/api/v1/vehicle-documents/files')
      .set('Host', c.host)
      .set('Cookie', await cookie(c))
      .set('X-CSRF-Token', CSRF)
      .set('Content-Type', type)
      .send(bytes);
  const download = async (c: Company, path: string) =>
    http()
      .get(path)
      .set('Host', c.host)
      .set('Cookie', await cookie(c))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  const company = async (
    slug: string,
    planVersionId: string,
    services: { modality: string; service: string }[],
  ): Promise<Company> => {
    const created = await asStaff('post', '/api/v1/platform/tenants', {
      slug,
      legalName: `${slug} SAC`,
      tradeName: `Empresa ${slug}`,
      taxIdType: 'RUC',
      taxId: `20${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      planVersionId,
      services,
      firstAdminEmail: `admin@${slug}.pe`,
    });
    expect(created.status).toBe(201);
    const link = created.body.firstAdminInvitation.link as string;
    const reg = await http()
      .post('/api/v1/hub/invitations/register')
      .set('Host', HUB)
      .set('Cookie', `__Host-yebo_csrf=${CSRF}`)
      .set('X-CSRF-Token', CSRF)
      .send({ token: link.split('#')[1], fullName: 'Gerencia General', password: PASSWORD });
    expect(reg.status).toBe(200);
    const userId = (
      await seed.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`admin@${slug}.pe`])
    ).rows[0]?.id as string;
    return { id: created.body.id, host: created.body.primaryHost, adminUserId: userId };
  };

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    seed = testBypassPool(DB, 2);
    await owner.query(
      `TRUNCATE plan_version_modules, plan_versions, plans, platform_audit_logs, platform_setup_tokens,
                platform_sessions, platform_users CASCADE`,
    );
    await owner.query(RESET_TENANT_DATA);
    await owner.query(
      `INSERT INTO permissions (id, code, module_code, description, is_sensitive, updated_at)
         SELECT gen_random_uuid(), c, 'ACCESS', c, false, now() FROM unnest($1::text[]) c
       ON CONFLICT (code) DO NOTHING`,
      [PERMISSION_CODES],
    );
    await owner.query(
      `INSERT INTO role_templates (id, code, name, permission_codes, updated_at)
         VALUES (gen_random_uuid(), 'ADMIN', 'Administrador', $1, now())
       ON CONFLICT (code) DO UPDATE SET permission_codes = EXCLUDED.permission_codes`,
      [PERMISSION_CODES],
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(nest, parseEnv(process.env), { swagger: false });
    await nest.init();
    app = nest;
    const redis = app.get(RedisService);
    const keys = await redis.client.keys('rl:*');
    if (keys.length > 0) await redis.client.del(...keys);
    staff = (await seedPlatformSession(seed, { email: 'flota@yebo.pe', role: 'SUPERADMIN', now: new Date() }))
      .cookie;
    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'flota', name: 'Flota' });
    const v = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
      basePrice: '99.00',
      billingInterval: 'MONTHLY',
      includedUsers: 5,
      extraUserPrice: '15.00',
      trialDays: 0,
      modules: ['PASSENGERS'],
    });
    await asStaff('post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
    a = await company('flota-a', v.body.id, [
      { modality: 'RIVER', service: 'PASSENGER' },
      { modality: 'LAND', service: 'PASSENGER' },
    ]);
    b = await company('flota-b', v.body.id, [{ modality: 'RIVER', service: 'PASSENGER' }]);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  let lancha = ''; // tipo fluvial
  let bus = ''; // tipo terrestre
  let busId = '';
  const busInput = (over: object = {}) => ({
    code: 'bus-01',
    name: 'Bus 01',
    vehicleTypeId: bus,
    registration: 'abc-123',
    status: 'ACTIVE',
    ownership: 'OWN',
    nominalCapacity: { passengers: 40, weightKg: 1500, volumeM3: 6 },
    features: ['Aire acondicionado', 'Baño'],
    ...over,
  });

  it('tipos: el catálogo global sugiere; cada tipo es de una modalidad que la empresa opera', async () => {
    const list = await as(a, 'get', '/api/v1/vehicle-types');
    expect(list.status).toBe(200);
    // 12 sugerencias desde la 6.6 (Van y Camioneta pickup 4×4), en el orden del catálogo: terrestres y fluviales.
    expect(list.body.catalog.map((c: { code: string }) => c.code)).toEqual([
      'BUS',
      'MINIBUS',
      'MINIVAN',
      'VAN',
      'CAR',
      'PICKUP',
      'TRUCK',
      'LANCHA',
      'MOTONAVE',
      'DESLIZADOR',
      'CHATA',
      'BOTE',
    ]);
    expect(list.body.types).toEqual([]);

    const l = await as(a, 'post', '/api/v1/vehicle-types', {
      name: 'Lancha rápida',
      modality: 'RIVER',
      catalogCode: 'LANCHA',
    });
    expect(l.status).toBe(201);
    expect(l.body).toMatchObject({
      modality: 'RIVER',
      catalogCode: 'LANCHA',
      archived: false,
      activeVehicles: 0,
    });
    lancha = l.body.id;
    bus = (
      await as(a, 'post', '/api/v1/vehicle-types', { name: 'Bus 2+2', modality: 'LAND', catalogCode: 'BUS' })
    ).body.id;

    // B solo opera fluvial; la sugerencia debe ser de la misma modalidad; nombre único; la modalidad no se edita.
    const land = await as(b, 'post', '/api/v1/vehicle-types', {
      name: 'Bus',
      modality: 'LAND',
      catalogCode: null,
    });
    expect(land.status).toBe(400);
    expect(land.body.error.message).toMatch(/no opera servicios de transporte terrestre/);
    expect(
      (await as(a, 'post', '/api/v1/vehicle-types', { name: 'Otra', modality: 'RIVER', catalogCode: 'BUS' }))
        .status,
    ).toBe(400);
    expect(
      (await as(a, 'post', '/api/v1/vehicle-types', { name: 'Bus 2+2', modality: 'LAND', catalogCode: null }))
        .status,
    ).toBe(409);
    expect(
      (
        await as(a, 'put', `/api/v1/vehicle-types/${lancha}`, {
          name: 'X',
          modality: 'LAND',
          catalogCode: null,
        })
      ).status,
    ).toBe(400);
    const renamed = await as(a, 'put', `/api/v1/vehicle-types/${lancha}`, {
      name: 'Lancha de pasajeros',
      catalogCode: 'LANCHA',
    });
    expect(renamed.body).toMatchObject({ name: 'Lancha de pasajeros', modality: 'RIVER' });
  });

  it('vehículos: código y placa normalizados y únicos; la modalidad se hereda del tipo y no cambia', async () => {
    const created = await as(a, 'post', '/api/v1/vehicles', busInput());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      code: 'BUS-01',
      registration: 'ABC-123',
      modality: 'LAND',
      vehicleTypeName: 'Bus 2+2',
      documents: 'NONE',
      nextExpiry: null,
      nominalCapacity: { passengers: 40, weightKg: 1500, volumeM3: 6 },
    });
    busId = created.body.id;

    const dupCode = await as(a, 'post', '/api/v1/vehicles', busInput({ registration: 'XYZ-999' }));
    expect(dupCode.status).toBe(409);
    expect(dupCode.body.error.message).toMatch(/código BUS-01/);
    const dupPlate = await as(a, 'post', '/api/v1/vehicles', busInput({ code: 'BUS-02' }));
    expect(dupPlate.status).toBe(409);
    expect(dupPlate.body.error.message).toMatch(/placa o matrícula ABC-123/);
    // La misma placa en otra empresa no choca (B crea su tipo fluvial).
    const bType = (
      await as(b, 'post', '/api/v1/vehicle-types', { name: 'Motonave', modality: 'RIVER', catalogCode: null })
    ).body.id;
    expect((await as(b, 'post', '/api/v1/vehicles', busInput({ vehicleTypeId: bType }))).status).toBe(201);

    // Cambiar a un tipo de otra modalidad → 400; de otra empresa → 400; sin el código en el PUT.
    const { code: _code, ...edit } = busInput();
    expect((await as(a, 'put', `/api/v1/vehicles/${busId}`, { ...edit, vehicleTypeId: lancha })).status).toBe(
      400,
    );
    expect((await as(a, 'put', `/api/v1/vehicles/${busId}`, { ...edit, vehicleTypeId: bType })).status).toBe(
      400,
    );
    expect((await as(a, 'put', `/api/v1/vehicles/${busId}`, busInput())).status).toBe(400);
    const edited = await as(a, 'put', `/api/v1/vehicles/${busId}`, {
      ...edit,
      name: 'Bus Pucallpa',
      status: 'MAINTENANCE',
      ownership: 'THIRD_PARTY',
    });
    expect(edited.body).toMatchObject({ code: 'BUS-01', name: 'Bus Pucallpa', status: 'MAINTENANCE' });
  });

  it('un tipo no se archiva con vehículos sin retirar; un vehículo no va a un tipo archivado', async () => {
    const blocked = await as(a, 'post', `/api/v1/vehicle-types/${bus}/archive`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/un vehículo sin retirar/);
    const { code: _c, ...edit } = busInput();
    await as(a, 'put', `/api/v1/vehicles/${busId}`, { ...edit, status: 'RETIRED' });
    expect((await as(a, 'post', `/api/v1/vehicle-types/${bus}/archive`)).body.archived).toBe(true);
    expect(
      (await as(a, 'post', '/api/v1/vehicles', busInput({ code: 'BUS-09', registration: 'Q-1234' }))).status,
    ).toBe(400);
    expect((await as(a, 'post', `/api/v1/vehicle-types/${bus}/restore`)).body.archived).toBe(false);
    await as(a, 'put', `/api/v1/vehicles/${busId}`, { ...edit, status: 'ACTIVE' });
  });

  let docFile = '';
  let soatId = '';

  it('archivos: PDF, JPEG o PNG comprobados por el contenido; imágenes sin metadatos; ≤ 10 MB', async () => {
    const pdf = await upload(a, PDF, 'application/pdf');
    expect(pdf.status).toBe(201);
    expect(pdf.body).toMatchObject({ mime: 'application/pdf', sizeBytes: PDF.length });
    docFile = pdf.body.id;

    // Foto JPEG con EXIF (cámara y GPS): se recodifica y no conserva los metadatos.
    const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#335577' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Make: 'Celular' }, IFD3: { GPSLatitudeRef: 'S' } } })
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();
    const img = await upload(a, photo, 'image/jpeg');
    expect(img.status).toBe(201);
    expect(img.body.mime).toBe('image/jpeg');
    const key = (
      await seed.query<{ k: string }>('SELECT storage_key AS k FROM file_assets WHERE id = $1', [img.body.id])
    ).rows[0]?.k as string;
    const stored = await app.get(ObjectStorage).get(key);
    expect((await sharp(stored?.body).metadata()).exif).toBeUndefined();

    // Contenido falso o no admitido → 400; > 10 MB → 413; tipo de cuerpo no admitido → 400.
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    for (const [bytes, type] of [
      [Buffer.from('<script>alert(1)</script>'), 'application/pdf'],
      [Buffer.from('%PDF-1.4 sin final'), 'application/pdf'],
      [gif, 'image/png'],
      [Buffer.from('hola'), 'image/jpeg'],
    ] as const) {
      expect((await upload(a, bytes, type)).status).toBe(400);
    }
    expect((await upload(a, Buffer.alloc(10 * 1024 * 1024 + 1, 0x25), 'application/pdf')).status).toBe(413);
    expect((await upload(a, PDF, 'text/plain')).status).toBe(400);
  });

  it('documentos: tipo según la modalidad, estado por vencimiento y renovación como historia', async () => {
    const docs = await as(a, 'get', `/api/v1/vehicles/${busId}/documents`);
    const codes = docs.body.types.map((t: { code: string }) => t.code);
    expect(codes).toEqual(expect.arrayContaining(['SOAT', 'REVISION_TECNICA', 'POLIZA_SEGURO']));
    expect(codes).not.toContain('CERT_MATRICULA');
    // Un tipo de otra modalidad → 400.
    expect(
      (
        await as(a, 'post', `/api/v1/vehicles/${busId}/documents`, {
          typeCode: 'CERT_MATRICULA',
          number: '1',
          issuedOn: null,
          expiresOn: null,
          fileAssetId: null,
        })
      ).status,
    ).toBe(400);

    const soat = await as(a, 'post', `/api/v1/vehicles/${busId}/documents`, {
      typeCode: 'SOAT',
      number: 'SOAT-2026-001',
      issuedOn: day(-345),
      expiresOn: day(20),
      fileAssetId: docFile,
    });
    expect(soat.status).toBe(201);
    expect(soat.body).toMatchObject({ status: 'EXPIRING', file: { id: docFile, mime: 'application/pdf' } });
    soatId = soat.body.id;
    const vehicle = (await as(a, 'get', '/api/v1/vehicles')).body.vehicles.find(
      (v: { id: string }) => v.id === busId,
    );
    expect(vehicle).toMatchObject({ documents: 'EXPIRING', nextExpiry: day(20) });

    // El mismo archivo en otro documento → 409; el tipo no cambia al editar → 400.
    expect(
      (
        await as(a, 'post', `/api/v1/vehicles/${busId}/documents`, {
          typeCode: 'REVISION_TECNICA',
          number: 'RT-1',
          issuedOn: null,
          expiresOn: day(-1),
          fileAssetId: docFile,
        })
      ).status,
    ).toBe(409);
    const rt = await as(a, 'post', `/api/v1/vehicles/${busId}/documents`, {
      typeCode: 'REVISION_TECNICA',
      number: 'RT-1',
      issuedOn: null,
      expiresOn: day(-1),
      fileAssetId: null,
    });
    expect(rt.body.status).toBe('EXPIRED');
    expect(
      (
        await as(a, 'put', `/api/v1/vehicles/${busId}/documents/${rt.body.id}`, {
          typeCode: 'SOAT',
          number: 'RT-1',
          issuedOn: null,
          expiresOn: null,
          fileAssetId: null,
        })
      ).status,
    ).toBe(400);
    let summary = (await as(a, 'get', '/api/v1/vehicles')).body.vehicles.find(
      (v: { id: string }) => v.id === busId,
    );
    expect(summary.documents).toBe('EXPIRED');

    // Renovación: una revisión nueva deja la vencida como historia; el resumen vuelve a «por vencer» (el SOAT).
    await as(a, 'post', `/api/v1/vehicles/${busId}/documents`, {
      typeCode: 'REVISION_TECNICA',
      number: 'RT-2',
      issuedOn: day(0),
      expiresOn: day(365),
      fileAssetId: null,
    });
    summary = (await as(a, 'get', '/api/v1/vehicles')).body.vehicles.find(
      (v: { id: string }) => v.id === busId,
    );
    expect(summary).toMatchObject({ documents: 'EXPIRING', nextExpiry: day(20) });
  });

  it('descarga privada: adjunto con CSP sandbox y sin caché; nunca por otra empresa ni por el portal', async () => {
    const path = `/api/v1/vehicles/${busId}/documents/${soatId}/file`;
    const res = await download(a, path);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="SOAT-SOAT-2026-001.pdf"');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);

    expect((await download(b, path)).status).toBe(404);
    expect((await http().get(path).set('Host', a.host)).status).toBe(401);
    // El portal público y las rutas del sitio no ven los archivos de documentos.
    expect((await http().get(`/api/v1/public/assets/${docFile}`).set('Host', a.host)).status).toBe(404);
    expect((await as(a, 'get', '/api/v1/site/assets')).body.assets).toEqual([]);
    // B no puede referenciar el archivo de A.
    const bVehicle = (await as(b, 'get', '/api/v1/vehicles')).body.vehicles[0].id;
    expect(
      (
        await as(b, 'post', `/api/v1/vehicles/${bVehicle}/documents`, {
          typeCode: 'OTRO',
          number: 'X',
          issuedOn: null,
          expiresOn: null,
          fileAssetId: docFile,
        })
      ).status,
    ).toBe(400);
  });

  it('reemplazar el archivo retira el anterior (DELETED y objeto borrado); archivar un documento', async () => {
    const key = (
      await seed.query<{ k: string }>('SELECT storage_key AS k FROM file_assets WHERE id = $1', [docFile])
    ).rows[0]?.k as string;
    const next = (await upload(a, PDF, 'application/pdf')).body.id as string;
    const replaced = await as(a, 'put', `/api/v1/vehicles/${busId}/documents/${soatId}`, {
      typeCode: 'SOAT',
      number: 'SOAT-2026-001',
      issuedOn: day(-345),
      expiresOn: day(20),
      fileAssetId: next,
    });
    expect(replaced.body.file.id).toBe(next);
    expect((await seed.query('SELECT status::text FROM file_assets WHERE id = $1', [docFile])).rows).toEqual([
      { status: 'DELETED' },
    ]);
    expect(await app.get(ObjectStorage).get(key)).toBeNull();

    const archived = await as(a, 'post', `/api/v1/vehicles/${busId}/documents/${soatId}/archive`);
    expect(archived.body.archived).toBe(true);
    const summary = (await as(a, 'get', '/api/v1/vehicles')).body.vehicles.find(
      (v: { id: string }) => v.id === busId,
    );
    expect(summary).toMatchObject({ documents: 'OK', nextExpiry: day(365) });
  });

  it('reglas de la base: código y modalidad fijos, modalidad coherente con el tipo, documentos privados', async () => {
    const app_ = testPool('app', DB, 1);
    const c = await app_.connect();
    const inTenant = async (sql: string, params: unknown[] = []) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.id]);
      try {
        return await c.query(sql, params);
      } finally {
        await c.query('ROLLBACK');
      }
    };
    try {
      for (const sql of [
        `UPDATE vehicles SET code = 'OTRO' WHERE id = $1`,
        `UPDATE vehicles SET modality = 'RIVER' WHERE id = $1`,
        `UPDATE vehicle_types SET modality = 'RIVER' WHERE id = (SELECT vehicle_type_id FROM vehicles WHERE id = $1)`,
        `UPDATE vehicle_documents SET type_code = 'OTRO' WHERE vehicle_id = $1`,
        `DELETE FROM vehicles WHERE id = $1`,
      ]) {
        await expect(inTenant(sql, [busId])).rejects.toMatchObject({ code: '42501' });
      }
      // Un vehículo fluvial con un tipo terrestre: la FK compuesta lo impide.
      await expect(
        inTenant(
          `INSERT INTO vehicles (id, tenant_id, code, name, vehicle_type_id, modality, registration_id, updated_at)
           VALUES (gen_random_uuid(), $1, 'X-1', 'XX', $2, 'RIVER', 'XX-111', now())`,
          [a.id, bus],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      // Un documento de vehículo público, o un PDF del sitio: CHECK.
      await expect(
        inTenant(
          `INSERT INTO file_assets (id, tenant_id, kind, visibility, status, storage_key, mime, size_bytes,
                                    checksum_sha256, uploaded_by_kind, uploaded_by_id)
           VALUES (gen_random_uuid(), $1::uuid, 'VEHICLE_DOCUMENT', 'PUBLIC', 'READY', 'tenants/' || $1::text || '/x.pdf',
                   'application/pdf', 10, decode(repeat('00', 32), 'hex'), 'MEMBERSHIP', gen_random_uuid())`,
          [a.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        inTenant(
          `INSERT INTO file_assets (id, tenant_id, kind, visibility, status, storage_key, mime, size_bytes,
                                    checksum_sha256, uploaded_by_kind, uploaded_by_id)
           VALUES (gen_random_uuid(), $1::uuid, 'SITE_LOGO', 'PUBLIC', 'READY', 'tenants/' || $1::text || '/y.pdf',
                   'application/pdf', 10, decode(repeat('00', 32), 'hex'), 'MEMBERSHIP', gen_random_uuid())`,
          [a.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      // Sin contexto, 0 filas. Por la conexión ya tomada: el pool tiene una sola y `app_.query` esperaría para siempre.
      expect((await c.query('SELECT count(*)::int AS n FROM vehicles')).rows[0].n).toBe(0);
    } finally {
      c.release();
      await app_.end();
    }
  });

  it('aislamiento, permisos y estados del tenant', async () => {
    expect((await as(b, 'put', `/api/v1/vehicles/${busId}`, busInput())).status).toBe(400); // el DTO rechaza code
    const { code: _c, ...edit } = busInput();
    expect((await as(b, 'put', `/api/v1/vehicles/${busId}`, edit)).status).toBe(404);
    expect((await as(b, 'get', `/api/v1/vehicles/${busId}/documents`)).status).toBe(404);
    expect((await as(a, 'get', '/api/v1/vehicles/no-es-un-id/documents')).status).toBe(404);

    const userId = (
      await seed.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), 'chofer@flota-a.pe', 'x', 'Chofer', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0]?.id as string;
    await seed.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [a.id, userId],
    );
    expect((await as(a, 'get', '/api/v1/vehicles', undefined, userId)).status).toBe(403);
    expect(
      (await as(a, 'get', `/api/v1/vehicles/${busId}/documents/${soatId}/file`, undefined, userId)).status,
    ).toBe(403);

    const to = (status: string) =>
      asStaff('post', `/api/v1/platform/tenants/${a.id}/status`, { to: status, reason: 'Prueba 6.2' });
    expect((await to('PAST_DUE')).status).toBe(200);
    expect((await to('SUSPENDED')).status).toBe(200);
    try {
      expect((await as(a, 'get', '/api/v1/vehicles')).status).toBe(200);
      expect((await download(a, `/api/v1/vehicles/${busId}/documents/${soatId}/file`)).status).toBe(200);
      expect((await as(a, 'put', `/api/v1/vehicles/${busId}`, edit)).status).toBe(403);
      expect((await upload(a, PDF, 'application/pdf')).status).toBe(403);
    } finally {
      expect((await to('ACTIVE')).status).toBe(200);
    }
  });
});
