/**
 * Fase 5.2 · Archivos del sitio (logo, favicon y portada) con almacenamiento S3 real (Garage, pnpm infra:up):
 * validación por contenido, recodificación sin metadatos (EXIF/GPS), orientación, límites, favicon del logo, servido
 * público por host con caché, referencias desde el sitio (misma empresa, tipo correcto), permisos y aislamiento.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { defaultSiteConfig, type SiteConfig } from '@yebo/contracts';
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

/** Imágenes de prueba generadas al vuelo. */
const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 11, g: 61, b: 145, alpha: 0.9 } } })
    .png()
    .toBuffer();
/** JPEG con EXIF de ubicación (GPS) y orientación 6 (girada 90°), como una foto vertical de móvil. */
const jpegWithGps = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: {
        IFD0: { Make: 'Telefono', Model: 'Prueba' },
        IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '8/1 22/1 0/1' },
      },
    })
    .toBuffer();

describe('Fase 5.2 · archivos del sitio', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let staff = '';
  let a: Company;
  let b: Company;

  const http = () => request(app.getHttpServer());
  const asStaff = (method: 'get' | 'post', path: string, body?: object) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', staff);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  const token = async (c: Company, userId = c.adminUserId) => {
    const sessions = app.get(SessionService);
    const identity = (await sessions.createIdentitySession({ userId, authMethods: ['pwd'] })).id;
    return (await sessions.openTenantSession({ identitySessionId: identity, host: c.host })).accessToken;
  };
  const as = async (c: Company, method: 'get' | 'put' | 'post', path: string, body?: object) => {
    const t = await token(c);
    const agent = http();
    let req = agent[method](path)
      .set('Host', c.host)
      .set('Cookie', `__Host-yebo_at=${t}; __Host-yebo_csrf=${CSRF}`);
    if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
    return body ? req.send(body) : req;
  };
  const upload = async (c: Company, kind: string, bytes: Buffer, type = 'image/png', userId?: string) => {
    const t = await token(c, userId);
    return http()
      .post(`/api/v1/site/assets?kind=${kind}`)
      .set('Host', c.host)
      .set('Cookie', `__Host-yebo_at=${t}; __Host-yebo_csrf=${CSRF}`)
      .set('X-CSRF-Token', CSRF)
      .set('Content-Type', type)
      .send(bytes);
  };
  const fetchPublic = (c: Company, path: string) =>
    http()
      .get(path)
      .set('Host', c.host)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  const company = async (slug: string, planVersionId: string): Promise<Company> => {
    const created = await asStaff('post', '/api/v1/platform/tenants', {
      slug,
      legalName: `${slug} SAC`,
      tradeName: `Empresa ${slug}`,
      taxIdType: 'RUC',
      taxId: `20${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      planVersionId,
      services: [{ modality: 'LAND', service: 'PASSENGER' }],
      firstAdminEmail: `admin@${slug}.pe`,
    });
    expect(created.status).toBe(201);
    const reg = await http()
      .post('/api/v1/hub/invitations/register')
      .set('Host', HUB)
      .set('Cookie', `__Host-yebo_csrf=${CSRF}`)
      .set('X-CSRF-Token', CSRF)
      .send({
        token: (created.body.firstAdminInvitation.link as string).split('#')[1],
        fullName: 'Gerencia General',
        password: PASSWORD,
      });
    expect(reg.status).toBe(200);
    const userId = (
      await seed.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`admin@${slug}.pe`])
    ).rows[0]?.id as string;
    return { id: created.body.id, host: created.body.primaryHost, adminUserId: userId };
  };
  const withAssets = (logo: string | null, hero: string | null): SiteConfig => {
    const c = defaultSiteConfig('X');
    return { ...c, logoAssetId: logo, hero: { ...c.hero, imageAssetId: hero } };
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
    expect(app.get(ObjectStorage).enabled).toBe(true); // Garage de pnpm infra:up
    const redis = app.get(RedisService);
    const keys = [...(await redis.client.keys('rl:*')), ...(await redis.client.keys('site:pub:*'))];
    if (keys.length > 0) await redis.client.del(...keys);
    staff = (
      await seedPlatformSession(seed, { email: 'archivos@yebo.pe', role: 'SUPERADMIN', now: new Date() })
    ).cookie;
    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'archivos', name: 'Archivos' });
    const v = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
      basePrice: '99.00',
      billingInterval: 'MONTHLY',
      includedUsers: 5,
      extraUserPrice: '15.00',
      trialDays: 0,
      modules: ['PASSENGERS', 'WHITE_LABEL'],
    });
    await asStaff('post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
    a = await company('archivos-a', v.body.id);
    b = await company('archivos-b', v.body.id);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  let logoId = '';
  let heroId = '';

  it('logo PNG: se recodifica, se sirve en el host de su empresa con caché larga y genera un favicon de 64 × 64', async () => {
    const res = await upload(a, 'logo', await png(1600, 800));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'logo', mime: 'image/png', width: 1024, height: 512 }); // reducido
    logoId = res.body.id;
    expect(res.body.url).toBe(`/api/v1/public/assets/${logoId}`);

    const got = await fetchPublic(a, res.body.url);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect((await sharp(got.body as Buffer).metadata()).width).toBe(1024);
    const etag = got.headers.etag as string;
    expect((await http().get(res.body.url).set('Host', a.host).set('If-None-Match', etag)).status).toBe(304);

    const fav = await fetchPublic(a, `${res.body.url}/favicon`);
    expect(fav.status).toBe(200);
    expect(fav.headers['content-type']).toBe('image/png');
    expect(await sharp(fav.body as Buffer).metadata()).toMatchObject({
      width: 64,
      height: 64,
      format: 'png',
    });

    const listed = await as(a, 'get', '/api/v1/site/assets');
    expect(listed.body.assets).toEqual([expect.objectContaining({ id: logoId, kind: 'logo' })]);
  });

  it('foto JPEG de móvil: se aplica la orientación y se eliminan los metadatos (GPS); la portada se guarda en WebP', async () => {
    const original = await jpegWithGps(1300, 2000); // vertical por EXIF (orientación 6) → 2000 × 1300 al girar
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const res = await upload(a, 'hero', original, 'image/jpeg');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'hero', mime: 'image/webp', width: 2000, height: 1300 });
    heroId = res.body.id;
    const stored = await fetchPublic(a, res.body.url);
    const meta = await sharp(stored.body as Buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    // Una portada no tiene favicon.
    expect((await http().get(`${res.body.url}/favicon`).set('Host', a.host)).status).toBe(404);
  });

  it('se rechaza lo que no es una imagen real, lo pequeño, lo enorme y el tipo de cuerpo equivocado', async () => {
    const text = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const fake = await upload(a, 'logo', text, 'image/png'); // dice ser PNG
    expect(fake.status).toBe(400);
    expect(fake.body.error.message).toBe('El archivo no es una imagen PNG, JPEG o WebP válida');
    // Imágenes reales de un formato no admitido (con tamaño suficiente: solo las frena la regla de formato).
    for (const other of [
      await sharp({ create: { width: 300, height: 300, channels: 3, background: '#336699' } })
        .gif()
        .toBuffer(),
      await sharp({ create: { width: 300, height: 300, channels: 3, background: '#336699' } })
        .tiff()
        .toBuffer(),
    ]) {
      const res = await upload(a, 'logo', other, 'image/png');
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('El archivo no es una imagen PNG, JPEG o WebP válida');
    }
    const small = await upload(a, 'hero', await png(800, 400));
    expect(small.status).toBe(400);
    expect(small.body.error.message).toContain('mínimo 1200 × 600');
    expect((await upload(a, 'logo', await png(40, 40))).status).toBe(400);
    const bomb = await sharp({ create: { width: 10000, height: 6000, channels: 3, background: '#ffffff' } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const bombRes = await upload(a, 'hero', bomb);
    expect(bombRes.status).toBe(400);
    expect(bombRes.body.error.message).toContain('demasiados píxeles');
    const header = (await png(300, 300)).subarray(0, 120); // cabecera válida, datos cortados
    expect((await upload(a, 'logo', Buffer.concat([header, Buffer.alloc(200)]))).status).toBe(400);
    expect((await upload(a, 'logo', Buffer.alloc(6 * 1024 * 1024, 1))).status).toBe(413);
    expect((await upload(a, 'logo', await png(300, 300), 'text/plain')).status).toBe(400);
    expect((await upload(a, 'icono', await png(300, 300))).status).toBe(400);
    const rows = await seed.query('SELECT 1 FROM file_assets WHERE tenant_id = $1', [a.id]);
    expect(rows.rowCount).toBe(2); // solo el logo y la portada válidos
  });

  it('el sitio solo referencia archivos listos de su empresa y del tipo correcto', async () => {
    const ok = await as(a, 'put', '/api/v1/site/draft', { config: withAssets(logoId, heroId) });
    expect(ok.status).toBe(200);
    expect((await as(a, 'post', '/api/v1/site/publish')).status).toBe(200);
    expect((await http().get('/api/v1/public/site').set('Host', a.host)).body.site.config).toMatchObject({
      logoAssetId: logoId,
      hero: { imageAssetId: heroId },
    });
    const swapped = await as(a, 'put', '/api/v1/site/draft', { config: withAssets(heroId, null) });
    expect(swapped.status).toBe(400);
    expect(swapped.body.error.message).toBe('El logo no es un archivo disponible de esta empresa');
    expect((await as(a, 'put', '/api/v1/site/draft', { config: withAssets(null, logoId) })).status).toBe(400);
    // Archivo de otra empresa (existe, pero el RLS lo oculta) e id inexistente.
    expect((await as(b, 'put', '/api/v1/site/draft', { config: withAssets(logoId, null) })).status).toBe(400);
    expect(
      (
        await as(a, 'put', '/api/v1/site/draft', {
          config: withAssets('0190f0a0-0000-7000-8000-000000000999', null),
        })
      ).status,
    ).toBe(400);
  });

  it('cada host solo sirve los archivos de su empresa; ids no válidos → 404', async () => {
    expect((await http().get(`/api/v1/public/assets/${logoId}`).set('Host', b.host)).status).toBe(404);
    expect((await http().get(`/api/v1/public/assets/${logoId}/favicon`).set('Host', b.host)).status).toBe(
      404,
    );
    expect((await http().get('/api/v1/public/assets/no-es-un-id').set('Host', a.host)).status).toBe(404);
    expect(
      (await http().get(`/api/v1/public/assets/${logoId}`).set('Host', 'desconocido.yebo.test')).status,
    ).toBe(404);
    // Un archivo retirado (DELETED) deja de servirse.
    await seed.query("UPDATE file_assets SET status = 'DELETED' WHERE id = $1", [heroId]);
    expect((await http().get(`/api/v1/public/assets/${heroId}`).set('Host', a.host)).status).toBe(404);
    // …ni se puede volver a referenciar desde el sitio.
    expect((await as(a, 'put', '/api/v1/site/draft', { config: withAssets(logoId, heroId) })).status).toBe(
      400,
    );
  });

  it('sin site.manage → 403; la empresa suspendida no sube archivos; RLS en file_assets', async () => {
    const userId = (
      await seed.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), 'cajero@archivos-a.pe', 'x', 'Cajero', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0]?.id as string;
    await seed.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
      [a.id, userId],
    );
    expect((await upload(a, 'logo', await png(300, 300), 'image/png', userId)).status).toBe(403);

    const to = (status: string) =>
      asStaff('post', `/api/v1/platform/tenants/${b.id}/status`, {
        to: status,
        reason: 'Prueba de archivos',
      });
    expect((await to('PAST_DUE')).status).toBe(200);
    expect((await to('SUSPENDED')).status).toBe(200);
    try {
      expect((await upload(b, 'logo', await png(300, 300))).status).toBe(403);
      expect((await as(b, 'get', '/api/v1/site/assets')).status).toBe(200);
    } finally {
      expect((await to('ACTIVE')).status).toBe(200);
    }

    const appPool = testPool('app', DB, 1);
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [b.id]);
      expect((await c.query('SELECT 1 FROM file_assets')).rowCount).toBe(0); // b no ve los de a
      await expect(c.query('DELETE FROM file_assets')).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
    } finally {
      c.release();
      await appPool.end();
    }
    // La clave del objeto siempre empieza por la empresa (CHECK), aunque se salte la API.
    await expect(
      seed.query(
        `INSERT INTO file_assets (tenant_id, kind, visibility, status, storage_key, mime, size_bytes, width, height,
                                  checksum_sha256, uploaded_by_kind, uploaded_by_id)
         VALUES ($1, 'SITE_LOGO', 'PUBLIC', 'READY', $2, 'image/png', 10, 1, 1, decode(repeat('00', 32), 'hex'),
                 'MEMBERSHIP', gen_random_uuid())`,
        [b.id, `tenants/${a.id}/site/robado.png`],
      ),
    ).rejects.toThrow(/file_assets_storage_key/);
  });
});
