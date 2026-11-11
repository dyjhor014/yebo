/**
 * Fase 5.1 · Sitio público de la empresa (white label; F5-Q1 a F5-Q6): borrador, publicación atómica, historial y
 * restauración; contraste AA del tema en el servidor; permiso site.manage y estados del tenant (CONFIGURE); portal
 * público con lo que permite el plan (WHITE_LABEL) y su caché; reglas de la base (inmutabilidad, uno de cada por
 * empresa, RLS). PostgreSQL y Redis reales.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { defaultSiteConfig, type SiteConfig } from '@yebo/contracts';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
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

describe('Fase 5.1 · sitio público de la empresa', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let staff = '';
  let basic = ''; // versión de plan sin WHITE_LABEL
  let branded = ''; // con WHITE_LABEL
  let a: Company; // sin el módulo
  let b: Company; // con el módulo

  const http = () => request(app.getHttpServer());
  const asStaff = (method: 'get' | 'post', path: string, body?: object) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', staff);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  const tokenFor = async (c: Company, userId = c.adminUserId) => {
    const sessions = app.get(SessionService);
    const identity = (await sessions.createIdentitySession({ userId, authMethods: ['pwd'] })).id;
    return (await sessions.openTenantSession({ identitySessionId: identity, host: c.host })).accessToken;
  };
  const as = async (
    c: Company,
    method: 'get' | 'put' | 'post',
    path: string,
    body?: object,
    userId?: string,
  ) => {
    const token = await tokenFor(c, userId);
    const agent = http();
    let req = agent[method](path)
      .set('Host', c.host)
      .set('Cookie', `__Host-yebo_at=${token}; __Host-yebo_csrf=${CSRF}`);
    if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
    return body ? req.send(body) : req;
  };
  const pub = (c: Company) => http().get('/api/v1/public/site').set('Host', c.host);
  /** Empresa nueva con su administrador registrado desde la invitación. */
  const company = async (slug: string, planVersionId: string): Promise<Company> => {
    const created = await asStaff('post', '/api/v1/platform/tenants', {
      slug,
      legalName: `${slug} SAC`,
      tradeName: `Empresa ${slug}`,
      taxIdType: 'RUC',
      taxId: `20${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      planVersionId,
      services: [
        { modality: 'RIVER', service: 'PASSENGER' },
        { modality: 'RIVER', service: 'CARGO' },
      ],
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
  /** Tema propio de la empresa: azul profundo con texto blanco y acento rojo, Lora, esquinas cuadradas. */
  const own = (c: SiteConfig = defaultSiteConfig('X')): SiteConfig => ({
    ...c,
    theme: { primary: '#0B3D91', accent: '#B42318', surface: 'light', radius: 'square', font: 'lora' },
    hero: { title: 'Viaja por el Ucayali', subtitle: 'Pasajeros y carga desde 1998', imageAssetId: null },
    sections: c.sections.map((s) => ({ ...s, enabled: true })),
    faq: [{ question: '¿Cuánto equipaje?', answer: 'Hasta 20 kg por pasajero.' }],
    contact: { ...c.contact, phones: [{ label: 'Central', number: '+51 61 571234' }] },
  });

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
    const keys = [...(await redis.client.keys('rl:*')), ...(await redis.client.keys('site:pub:*'))];
    if (keys.length > 0) await redis.client.del(...keys);
    staff = (await seedPlatformSession(seed, { email: 'sitio@yebo.pe', role: 'SUPERADMIN', now: new Date() }))
      .cookie;
    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'sitio', name: 'Sitio' });
    const version = async (modules: string[]) => {
      const v = await asStaff('post', `/api/v1/platform/plans/${plan.body.id}/versions`, {
        basePrice: '99.00',
        billingInterval: 'MONTHLY',
        includedUsers: 5,
        extraUserPrice: '15.00',
        trialDays: 0,
        modules,
      });
      await asStaff('post', `/api/v1/platform/plan-versions/${v.body.id}/publish`);
      return v.body.id as string;
    };
    basic = await version(['PASSENGERS']);
    branded = await version(['PASSENGERS', 'WHITE_LABEL']);
    a = await company('sitio-basico', basic);
    b = await company('sitio-marca', branded);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  describe('editor y publicación', () => {
    it('sin publicar: el editor está vacío y el portal muestra la configuración por defecto con los servicios', async () => {
      const ed = await as(b, 'get', '/api/v1/site');
      expect(ed.status).toBe(200);
      expect(ed.body).toEqual({ whiteLabel: true, draft: null, published: null });
      expect((await as(a, 'get', '/api/v1/site')).body.whiteLabel).toBe(false);
      const portal = await pub(b);
      // Sin `whiteLabel` en público: el portal no revela qué incluye el plan (revisión de la 5.1).
      expect(portal.body.site).toEqual({ version: null, config: defaultSiteConfig('Empresa sitio-marca') });
      expect(portal.body.services).toEqual([
        { modality: 'RIVER', service: 'PASSENGER' },
        { modality: 'RIVER', service: 'CARGO' },
      ]);
    });

    it('guardar valida contraste AA, archivos y forma; un borrador por empresa, que se reemplaza', async () => {
      const grey = { ...own(), theme: { ...own().theme, primary: '#7F7F7F' } };
      const bad = await as(b, 'put', '/api/v1/site/draft', { config: grey });
      expect(bad.status).toBe(400);
      expect(bad.body.error.message).toContain('El texto sobre el color principal');
      const accent = { ...own(), theme: { ...own().theme, accent: '#FFD400' } };
      expect((await as(b, 'put', '/api/v1/site/draft', { config: accent })).body.error.message).toContain(
        'acento',
      );
      const logo = { ...own(), logoAssetId: '0190f0a0-0000-7000-8000-000000000001' };
      expect((await as(b, 'put', '/api/v1/site/draft', { config: logo })).body.error.message).toContain(
        'El logo no es un archivo disponible de esta empresa',
      );
      const http = { ...own(), social: { ...own().social, website: 'http://naviera.pe' } };
      expect((await as(b, 'put', '/api/v1/site/draft', { config: http })).status).toBe(400);
      expect((await as(b, 'put', '/api/v1/site/draft', { config: { ...own(), css: 'body{}' } })).status).toBe(
        400,
      );
      // Válido para el esquema pero demasiado grande para la base (64 KB): 400 claro, no un 500 (revisión de la 5.1).
      const big = {
        ...own(),
        policies: Array.from({ length: 10 }, (_, i) => ({ title: `Política ${i}`, body: 'ñ'.repeat(6000) })),
      };
      const tooBig = await as(b, 'put', '/api/v1/site/draft', { config: big });
      expect(tooBig.status).toBe(400);
      expect(tooBig.body.error.message).toMatch(/^El sitio ocupa \d+ KB y el máximo es 60 KB/);
      expect((await seed.query('SELECT 1 FROM site_versions WHERE tenant_id = $1', [b.id])).rowCount).toBe(0);

      const first = await as(b, 'put', '/api/v1/site/draft', { config: own() });
      expect(first.status).toBe(200);
      expect(first.body.draft).toMatchObject({ version: 1, status: 'DRAFT', publishedAt: null });
      const second = await as(b, 'put', '/api/v1/site/draft', {
        config: { ...own(), hero: { ...own().hero, subtitle: 'Desde 1998' } },
      });
      expect(second.body.draft).toMatchObject({ version: 1, config: { hero: { subtitle: 'Desde 1998' } } });
      expect((await seed.query('SELECT 1 FROM site_versions WHERE tenant_id = $1', [b.id])).rowCount).toBe(1);
      // El borrador no se ve en público (leyendo la base, no la caché).
      await app.get(RedisService).client.del(`site:pub:v1:${b.id}`);
      expect((await pub(b)).body.site.version).toBeNull();
    });

    it('publicar: el borrador pasa a publicado, la anterior se archiva y el portal cambia al momento (caché)', async () => {
      expect((await pub(b)).body.site.version).toBeNull(); // queda en caché
      const p1 = await as(b, 'post', '/api/v1/site/publish');
      expect(p1.status).toBe(200);
      expect(p1.body).toMatchObject({ draft: null, published: { version: 1, status: 'PUBLISHED' } });
      const portal = await pub(b);
      expect(portal.body.site).toMatchObject({
        version: 1,
        config: { theme: { primary: '#0B3D91', font: 'lora' }, hero: { title: 'Viaja por el Ucayali' } },
      });
      expect((await as(b, 'post', '/api/v1/site/publish')).status).toBe(409); // sin borrador
      const row = await seed.query(
        'SELECT published_by_kind::text AS kind, published_by_id FROM site_versions WHERE tenant_id = $1 AND version = 1',
        [b.id],
      );
      const membership = await seed.query<{ id: string }>(
        'SELECT id FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
        [b.id, b.adminUserId],
      );
      expect(row.rows).toEqual([{ kind: 'MEMBERSHIP', published_by_id: membership.rows[0]?.id }]);

      await as(b, 'put', '/api/v1/site/draft', {
        config: { ...own(), hero: { ...own().hero, title: 'Versión dos' } },
      });
      const p2 = await as(b, 'post', '/api/v1/site/publish');
      expect(p2.body.published).toMatchObject({ version: 2, config: { hero: { title: 'Versión dos' } } });
      expect((await pub(b)).body.site).toMatchObject({
        version: 2,
        config: { hero: { title: 'Versión dos' } },
      });
      const versions = await as(b, 'get', '/api/v1/site/versions');
      expect(
        versions.body.versions.map((v: { version: number; status: string }) => [v.version, v.status]),
      ).toEqual([
        [2, 'PUBLISHED'],
        [1, 'ARCHIVED'],
      ]);
    });

    it('restaurar publica una COPIA de una versión archivada como versión nueva; el borrador no cambia', async () => {
      await as(b, 'put', '/api/v1/site/draft', {
        config: { ...own(), hero: { ...own().hero, title: 'Borrador' } },
      });
      expect((await as(b, 'post', '/api/v1/site/versions/2/restore')).status).toBe(409); // la publicada
      expect((await as(b, 'post', '/api/v1/site/versions/99/restore')).status).toBe(404);
      expect((await as(b, 'post', '/api/v1/site/versions/abc/restore')).status).toBe(404);
      const r = await as(b, 'post', '/api/v1/site/versions/1/restore');
      expect(r.status).toBe(200);
      expect(r.body.published).toMatchObject({
        version: 4,
        config: { hero: { title: 'Viaja por el Ucayali' } },
      });
      expect(r.body.draft).toMatchObject({ version: 3, config: { hero: { title: 'Borrador' } } });
      expect((await pub(b)).body.site).toMatchObject({
        version: 4,
        config: { hero: { title: 'Viaja por el Ucayali' } },
      });
      const versions = await as(b, 'get', '/api/v1/site/versions');
      expect(
        versions.body.versions.map((v: { version: number; status: string }) => [v.version, v.status]),
      ).toEqual([
        [4, 'PUBLISHED'],
        [3, 'DRAFT'],
        [2, 'ARCHIVED'],
        [1, 'ARCHIVED'],
      ]);
      // Autor de cada versión (5.4): el nombre de la persona; el borrador, ninguno.
      expect(
        versions.body.versions.map((v: { version: number; publishedBy: unknown }) => [
          v.version,
          v.publishedBy,
        ]),
      ).toEqual([
        [4, { kind: 'MEMBER', name: 'Gerencia General' }],
        [3, null],
        [2, { kind: 'MEMBER', name: 'Gerencia General' }],
        [1, { kind: 'MEMBER', name: 'Gerencia General' }],
      ]);
    });

    it('cinco publicaciones simultáneas: una sola gana (las demás 409) y sigue habiendo una publicada', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => as(b, 'post', '/api/v1/site/publish')),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
      const live = await seed.query(
        "SELECT status::text FROM site_versions WHERE tenant_id = $1 AND status <> 'ARCHIVED' ORDER BY status",
        [b.id],
      );
      expect(live.rows).toEqual([{ status: 'PUBLISHED' }]);
      expect((await pub(b)).body.site.version).toBe(3);
    });
  });

  it('cinco guardados simultáneos del primer borrador: todos responden 200 y queda un solo borrador', async () => {
    const c = await company('sitio-carrera', basic);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        as(c, 'put', '/api/v1/site/draft', {
          config: { ...own(), hero: { ...own().hero, title: `Intento ${i}` } },
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const rows = await seed.query('SELECT version, status::text FROM site_versions WHERE tenant_id = $1', [
      c.id,
    ]);
    expect(rows.rows).toEqual([{ version: 1, status: 'DRAFT' }]);
  });

  describe('plan (F5-Q4), permiso (F5-Q5) y estados del tenant', () => {
    it('sin WHITE_LABEL se publica lo básico: tema YEBO, portada con el nombre y servicios, sucursales y contacto', async () => {
      await as(a, 'put', '/api/v1/site/draft', { config: own() });
      expect((await as(a, 'post', '/api/v1/site/publish')).status).toBe(200);
      const portal = await pub(a);
      expect(portal.body.site.config.theme).toEqual(defaultSiteConfig('x').theme);
      expect(portal.body.site.config.hero).toEqual({
        title: 'Empresa sitio-basico',
        subtitle: '',
        imageAssetId: null,
      });
      expect(
        portal.body.site.config.sections
          .filter((s: { enabled: boolean }) => s.enabled)
          .map((s: { kind: string }) => s.kind),
      ).toEqual(['services', 'branches', 'contact']);
      expect(portal.body.site.config.faq).toEqual([]);
      expect(portal.body.site.config.contact.phones).toEqual([{ label: 'Central', number: '+51 61 571234' }]);
      // Lo guardado no se pierde: si la empresa contrata el módulo, se publica su tema sin volver a editar.
      expect((await as(a, 'get', '/api/v1/site')).body.published.config.theme.primary).toBe('#0B3D91');
    });

    it('al conceder WHITE_LABEL (excepción de módulo) el portal publica su tema; ≤ 60 s de caché o al publicar', async () => {
      const ov = await asStaff('post', `/api/v1/platform/tenants/${a.id}/module-overrides`, {
        moduleCode: 'WHITE_LABEL',
        effect: 'GRANT',
        reason: 'Prueba de marca propia',
      });
      expect(ov.status).toBe(201);
      await app.get(RedisService).client.del(`site:pub:v1:${a.id}`); // equivale a esperar la caducidad
      expect((await pub(a)).body.site).toMatchObject({ config: { theme: { primary: '#0B3D91' } } });
    });

    it('sin site.manage → 403; sin sesión → 401; la empresa suspendida consulta pero no guarda ni publica', async () => {
      const userId = (
        await seed.query<{ id: string }>(
          `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
           VALUES (gen_random_uuid(), 'cajero@sitio-marca.pe', 'x', 'Cajero', 'ACTIVE', now()) RETURNING id`,
        )
      ).rows[0]?.id as string;
      await seed.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`,
        [b.id, userId],
      );
      expect((await as(b, 'get', '/api/v1/site', undefined, userId)).status).toBe(403);
      expect((await as(b, 'post', '/api/v1/site/publish', undefined, userId)).status).toBe(403);
      expect((await http().get('/api/v1/site').set('Host', b.host)).status).toBe(401);

      // Por la API del staff (invalida la caché del host): ACTIVE → PAST_DUE → SUSPENDED, y de vuelta a ACTIVE.
      const to = (status: string) =>
        asStaff('post', `/api/v1/platform/tenants/${b.id}/status`, {
          to: status,
          reason: 'Prueba del sitio',
        });
      expect((await to('PAST_DUE')).status).toBe(200);
      expect((await to('SUSPENDED')).status).toBe(200);
      try {
        expect((await as(b, 'get', '/api/v1/site')).status).toBe(200);
        expect((await as(b, 'put', '/api/v1/site/draft', { config: own() })).status).toBe(403);
        expect((await as(b, 'post', '/api/v1/site/publish')).status).toBe(403);
        expect((await pub(b)).status).toBe(200); // el portal sigue visible (multitenancy §5)
      } finally {
        expect((await to('ACTIVE')).status).toBe(200);
      }
    });
  });

  describe('revisión de la 5.1', () => {
    it('una versión publicada que ya no valida no tumba el portal: se sirve la configuración por defecto', async () => {
      const c = await company('sitio-roto', branded);
      await seed.query(
        `INSERT INTO site_versions (tenant_id, version, status, live_slot, schema_version, config, updated_at,
                                    published_at, published_by_kind, published_by_id)
         VALUES ($1, 1, 'PUBLISHED', 'PUBLISHED', 1, '{"schemaVersion": 1, "theme": "antiguo"}'::jsonb, now(),
                 now(), 'MEMBERSHIP', gen_random_uuid())`,
        [c.id],
      );
      const portal = await pub(c);
      expect(portal.status).toBe(200);
      expect(portal.body.site).toEqual({ version: null, config: defaultSiteConfig('Empresa sitio-roto') });
      // El historial no lee el contenido: tampoco falla.
      const versions = await as(c, 'get', '/api/v1/site/versions');
      expect(versions.status).toBe(200);
      expect(versions.body.versions).toEqual([expect.objectContaining({ version: 1, status: 'PUBLISHED' })]);
    });

    it('staff de YEBO con soporte: FULL publica (autor PLATFORM_USER); READ_ONLY consulta pero no guarda', async () => {
      const support = async (scope: 'FULL' | 'READ_ONLY') => {
        const g = await asStaff('post', `/api/v1/platform/tenants/${b.id}/support-grants`, {
          reason: 'Ajustar el sitio a pedido de la empresa',
          scope,
          durationMinutes: 60,
        });
        expect(g.status).toBe(201);
        const handoff = await asStaff(
          'post',
          `/api/v1/platform/tenants/${b.id}/support-grants/${g.body.id}/handoff`,
        );
        const url = new URL(handoff.body.url);
        const redeem = await http().get(`${url.pathname}${url.search}`).set('Host', b.host);
        const cookie = ((redeem.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
          .find((x) => x.startsWith('__Host-yebo_support='))
          ?.split(';')[0];
        expect(cookie).toBeTruthy();
        return (method: 'get' | 'put' | 'post', path: string, body?: object) => {
          const agent = http();
          let req = agent[method](path)
            .set('Host', b.host)
            .set('Cookie', `${cookie}; __Host-yebo_csrf=${CSRF}`);
          if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
          return body ? req.send(body) : req;
        };
      };
      const readOnly = await support('READ_ONLY');
      expect((await readOnly('get', '/api/v1/site')).status).toBe(200);
      expect((await readOnly('put', '/api/v1/site/draft', { config: own() })).status).toBe(403);
      expect((await readOnly('post', '/api/v1/site/publish')).status).toBe(403);

      const full = await support('FULL');
      const staffId = (
        await seed.query<{ id: string }>("SELECT id FROM platform_users WHERE email = 'sitio@yebo.pe'")
      ).rows[0]?.id;
      expect(
        (await full('put', '/api/v1/site/draft', { config: { ...own(), footerText: 'Soporte YEBO' } }))
          .status,
      ).toBe(200);
      const published = await full('post', '/api/v1/site/publish');
      expect(published.status).toBe(200);
      const row = await seed.query(
        `SELECT published_by_kind::text AS kind, published_by_id FROM site_versions
          WHERE tenant_id = $1 AND status = 'PUBLISHED'`,
        [b.id],
      );
      expect(row.rows).toEqual([{ kind: 'PLATFORM_USER', published_by_id: staffId }]);
      // La empresa ve «Soporte YEBO», nunca el nombre ni el id del staff.
      const versions = await as(b, 'get', '/api/v1/site/versions');
      const latest = versions.body.versions.find((v: { status: string }) => v.status === 'PUBLISHED');
      expect(latest.publishedBy).toEqual({ kind: 'SUPPORT' });
      expect(JSON.stringify(versions.body)).not.toContain(staffId as string);
    });
  });

  describe('reglas de la base de datos (también saltándose la API)', () => {
    it('publicada y archivada no cambian; no se borra; no nace archivada; un borrador y una publicada por empresa', async () => {
      const q = (sql: string, params: unknown[] = []) => seed.query(sql, params);
      // Estado de partida: un borrador y una publicada (las publicaciones simultáneas consumieron el borrador).
      expect((await as(b, 'put', '/api/v1/site/draft', { config: own() })).status).toBe(200);
      const archived = (
        await q("SELECT id FROM site_versions WHERE tenant_id = $1 AND status = 'ARCHIVED' LIMIT 1", [b.id])
      ).rows[0]?.id;
      const published = (
        await q("SELECT id FROM site_versions WHERE tenant_id = $1 AND status = 'PUBLISHED'", [b.id])
      ).rows[0]?.id;
      await expect(
        q("UPDATE site_versions SET config = '{}'::jsonb WHERE id = $1", [published]),
      ).rejects.toThrow(/publicada no cambia/);
      await expect(
        q("UPDATE site_versions SET status = 'DRAFT', live_slot = 'DRAFT' WHERE id = $1", [published]),
      ).rejects.toThrow(/publicada no cambia/);
      await expect(
        q("UPDATE site_versions SET status = 'PUBLISHED', live_slot = 'PUBLISHED' WHERE id = $1", [archived]),
      ).rejects.toThrow(/archivada no cambia/);
      await expect(
        q('UPDATE site_versions SET version = version + 100 WHERE id = $1', [archived]),
      ).rejects.toThrow(/identidad/);
      await expect(q('DELETE FROM site_versions WHERE id = $1', [archived])).rejects.toThrow(/no se borran/);
      // Un borrador no se archiva (aunque traiga fecha y autor para pasar el CHECK): se publica.
      const draft = (
        await q("SELECT id FROM site_versions WHERE tenant_id = $1 AND status = 'DRAFT'", [b.id])
      ).rows[0]?.id;
      await expect(
        q(
          `UPDATE site_versions SET status = 'ARCHIVED', live_slot = NULL, published_at = now(),
                  published_by_kind = 'MEMBERSHIP', published_by_id = gen_random_uuid() WHERE id = $1`,
          [draft],
        ),
      ).rejects.toThrow(/un borrador se publica, no se archiva/);
      const insert = (status: string, slot: string | null, published: boolean) =>
        q(
          `INSERT INTO site_versions (tenant_id, version, status, live_slot, schema_version, config, updated_at,
                                      published_at, published_by_kind, published_by_id)
           VALUES ($1, 500 + (random() * 400)::int, $2::site_version_status, $3::site_version_status, 1, '{}'::jsonb, now(),
                   ${published ? "now(), 'MEMBERSHIP', gen_random_uuid()" : 'NULL, NULL, NULL'})`,
          [b.id, status, slot],
        );
      await expect(insert('ARCHIVED', null, true)).rejects.toThrow(/nace como borrador o publicada/);
      await expect(insert('PUBLISHED', 'PUBLISHED', true)).rejects.toThrow(/live_slot_key/); // ya hay una publicada
      await expect(insert('DRAFT', 'DRAFT', false)).rejects.toThrow(/live_slot_key/); // ya hay un borrador
      await expect(insert('DRAFT', null, false)).rejects.toThrow(/site_versions_live_slot/);
      await expect(insert('DRAFT', 'DRAFT', true)).rejects.toThrow(/site_versions_published/);
    });

    it('RLS: con el rol de la aplicación, cada empresa solo ve y toca sus versiones', async () => {
      const appPool = testPool('app', DB, 1);
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [a.id]);
        const seen = await c.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM site_versions');
        expect(seen.rows).toEqual([{ tenant_id: a.id }]);
        const touched = await c.query(
          "UPDATE site_versions SET updated_at = now() WHERE tenant_id = $1 AND status = 'DRAFT'",
          [b.id],
        );
        expect(touched.rowCount).toBe(0);
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        const none = await c.query('SELECT 1 FROM site_versions'); // sin contexto: nada
        expect(none.rowCount).toBe(0);
        await c.query('ROLLBACK');
      } finally {
        c.release();
        await appPool.end();
      }
    });
  });
});
