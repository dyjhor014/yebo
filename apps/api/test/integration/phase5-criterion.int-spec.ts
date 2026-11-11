/**
 * Criterio de aceptación de la Fase 5 (roadmap): «Dos portales visualmente distintos sin duplicar apps».
 *
 * Parte de la API, en la CI: tres empresas reales, cada una con su administrador registrado desde la invitación,
 * configuran su sitio por la API de la empresa (subir el logo, guardar el borrador y publicar) y el portal público
 * de cada host devuelve SOLO su documento publicado. Dos con WHITE_LABEL publican temas distintos; la tercera, sin el
 * módulo, recibe el tema YEBO con su contenido básico (F5-Q4). Publicar en una no toca a las otras (caché por
 * empresa). El documento es el único dato que cambia entre empresas: el código del portal es el mismo (lo
 * comprueban la unitaria de tokens de apps/web y el E2E 06-portal con la misma compilación).
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { SITE_SURFACES, contrastRatio, defaultSiteConfig, type SiteConfig } from '@yebo/contracts';
import type { Pool } from 'pg';
import sharp from 'sharp';
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

type Company = { id: string; host: string; adminUserId: string; tradeName: string };

/** Logo de prueba de un color (la API lo recodifica a PNG y genera el favicon). */
const logo = (r: number, g: number, b: number) =>
  sharp({ create: { width: 320, height: 120, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();

/** Sitio propio: mismo esquema y secciones, distinto tema, portada y contenido. */
function site(tradeName: string, over: Partial<SiteConfig>): SiteConfig {
  const base = defaultSiteConfig(tradeName);
  return {
    ...base,
    sections: base.sections.map((s) => ({ ...s, enabled: true })),
    contact: { ...base.contact, whatsapp: '+51 961 234 567' },
    ...over,
  };
}

describe('Fase 5 · criterio de aceptación: dos portales visualmente distintos sin duplicar apps', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let staff = '';
  let naviera: Company; // WHITE_LABEL: oscuro, Lora, verde lima
  let ribera: Company; // WHITE_LABEL: claro, Montserrat, azul
  let oriente: Company; // sin el módulo: tema YEBO

  const http = () => request(app.getHttpServer());
  const asStaff = (method: 'get' | 'post', path: string, body?: object) => {
    let req = http()[method](path).set('Host', ADMIN).set('Cookie', staff);
    if (method !== 'get') req = req.set('X-CSRF-Token', STAFF_CSRF);
    return body ? req.send(body) : req;
  };
  const cookie = async (c: Company) => {
    const sessions = app.get(SessionService);
    const identity = (await sessions.createIdentitySession({ userId: c.adminUserId, authMethods: ['pwd'] }))
      .id;
    const token = (await sessions.openTenantSession({ identitySessionId: identity, host: c.host }))
      .accessToken;
    return `__Host-yebo_at=${token}; __Host-yebo_csrf=${CSRF}`;
  };
  const as = async (c: Company, method: 'get' | 'put' | 'post', path: string, body?: object) => {
    const session = await cookie(c);
    const agent = http();
    let req = agent[method](path).set('Host', c.host).set('Cookie', session);
    if (method !== 'get') req = req.set('X-CSRF-Token', CSRF);
    return body ? req.send(body) : req;
  };
  const portal = (c: Company) => http().get('/api/v1/public/site').set('Host', c.host);

  const company = async (slug: string, tradeName: string, planVersionId: string): Promise<Company> => {
    const created = await asStaff('post', '/api/v1/platform/tenants', {
      slug,
      legalName: `${tradeName} SAC`,
      tradeName,
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
      .send({ token: link.split('#')[1], fullName: `Gerencia ${tradeName}`, password: PASSWORD });
    expect(reg.status).toBe(200);
    const userId = (
      await seed.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`admin@${slug}.pe`])
    ).rows[0]?.id as string;
    return { id: created.body.id, host: created.body.primaryHost, adminUserId: userId, tradeName };
  };

  /** Lo que hace la persona administradora en «Mi sitio»: subir el logo, guardar el borrador y publicar. */
  const configure = async (c: Company, config: SiteConfig, color: [number, number, number]) => {
    const up = await http()
      .post('/api/v1/site/assets?kind=logo')
      .set('Host', c.host)
      .set('Cookie', await cookie(c))
      .set('X-CSRF-Token', CSRF)
      .set('Content-Type', 'image/png')
      .send(await logo(...color));
    expect(up.status).toBe(201);
    const withLogo = { ...config, logoAssetId: up.body.id as string };
    const saved = await as(c, 'put', '/api/v1/site/draft', { config: withLogo });
    expect(saved.status).toBe(200);
    const published = await as(c, 'post', '/api/v1/site/publish');
    expect(published.status).toBe(200);
    return withLogo;
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
    const keys = [...(await redis.client.keys('rl:*')), ...(await redis.client.keys('site:pub:*'))];
    if (keys.length > 0) await redis.client.del(...keys);
    staff = (
      await seedPlatformSession(seed, { email: 'criterio5@yebo.pe', role: 'SUPERADMIN', now: new Date() })
    ).cookie;

    const plan = await asStaff('post', '/api/v1/platform/plans', { code: 'marca', name: 'Marca propia' });
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
    const branded = await version(['PASSENGERS', 'WHITE_LABEL']);
    const basic = await version(['PASSENGERS']);
    naviera = await company('naviera-ucayali', 'Naviera Ucayali', branded);
    ribera = await company('ribera-amazonica', 'Ribera Amazónica', branded);
    oriente = await company('transportes-oriente', 'Transportes del Oriente', basic);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  let navieraSite: SiteConfig;
  let riberaSite: SiteConfig;
  let orienteSite: SiteConfig;

  it('cada empresa configura y publica su sitio desde su propia API', async () => {
    navieraSite = await configure(
      naviera,
      site('Naviera Ucayali', {
        theme: { primary: '#C5F36B', accent: '#16C7B2', surface: 'dark', radius: 'round', font: 'lora' },
        hero: {
          title: 'Viaja por el Ucayali',
          subtitle: 'Pucallpa ⇄ Iquitos desde 1998.',
          imageAssetId: null,
        },
        faq: [{ question: '¿Cuánto equipaje puedo llevar?', answer: 'Hasta 20 kg por pasajero.' }],
      }),
      [197, 243, 107],
    );
    riberaSite = await configure(
      ribera,
      site('Ribera Amazónica', {
        theme: {
          primary: '#0B3D91',
          accent: '#B42318',
          surface: 'light',
          radius: 'square',
          font: 'montserrat',
        },
        hero: {
          title: 'Viaja con Ribera',
          subtitle: 'Pasajeros y carga por el Amazonas.',
          imageAssetId: null,
        },
        sections: [...defaultSiteConfig('x').sections].reverse().map((s) => ({ ...s, enabled: true })),
        schedule: [{ label: 'Iquitos → Santa Rosa', value: 'Diario, 6:00' }],
      }),
      [11, 61, 145],
    );
    orienteSite = await configure(
      oriente,
      site('Transportes del Oriente', {
        theme: {
          primary: '#7A1F5C',
          accent: '#7A1F5C',
          surface: 'light',
          radius: 'soft',
          font: 'nunito-sans',
        },
        hero: { title: 'Este título no se publica sin el módulo', subtitle: '', imageAssetId: null },
        branches: [
          { name: 'Tarapoto', address: 'Jr. Lamas 300', city: 'Tarapoto', phone: null, hours: null },
        ],
      }),
      [122, 31, 92],
    );
  });

  it('dos portales con WHITE_LABEL: cada host sirve solo su documento publicado, con temas distintos', async () => {
    const a = await portal(naviera);
    const b = await portal(ribera);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.tenant.tradeName).toBe('Naviera Ucayali');
    expect(b.body.tenant.tradeName).toBe('Ribera Amazónica');
    expect(a.body.site).toEqual({ version: 1, config: navieraSite });
    expect(b.body.site).toEqual({ version: 1, config: riberaSite });

    // Visualmente distintos: cada token del tema, la portada, el logo y el orden de las secciones.
    const [ta, tb] = [a.body.site.config.theme, b.body.site.config.theme];
    for (const k of ['primary', 'accent', 'surface', 'radius', 'font'] as const)
      expect(ta[k]).not.toBe(tb[k]);
    expect(a.body.site.config.hero.title).not.toBe(b.body.site.config.hero.title);
    expect(a.body.site.config.logoAssetId).not.toBe(b.body.site.config.logoAssetId);
    expect(a.body.site.config.sections.map((s: { kind: string }) => s.kind)).not.toEqual(
      b.body.site.config.sections.map((s: { kind: string }) => s.kind),
    );
    // Y los dos legibles (AA), validados por la API al guardar y al publicar.
    for (const t of [ta, tb]) {
      expect(
        contrastRatio(t.accent, SITE_SURFACES[t.surface as 'light' | 'dark'].background),
      ).toBeGreaterThanOrEqual(4.5);
    }

    // Nada de una empresa aparece en el portal de la otra.
    expect(JSON.stringify(a.body)).not.toMatch(/Ribera|Santa Rosa|#0B3D91/);
    expect(JSON.stringify(b.body)).not.toMatch(/Naviera|Ucayali|#C5F36B/);
  });

  it('el logo de cada empresa solo se sirve en su host', async () => {
    const fetch = (host: string, id: string) =>
      http().get(`/api/v1/public/assets/${id}`).set('Host', host).buffer(true);
    for (const [own, other, cfg] of [
      [naviera, ribera, navieraSite],
      [ribera, naviera, riberaSite],
    ] as const) {
      const id = cfg.logoAssetId as string;
      expect((await fetch(own.host, id)).status).toBe(200);
      expect((await fetch(other.host, id)).status).toBe(404);
      expect((await http().get(`/api/v1/public/assets/${id}/favicon`).set('Host', own.host)).status).toBe(
        200,
      );
    }
  });

  it('sin WHITE_LABEL: el mismo portal con el tema YEBO, su nombre y solo lo básico (F5-Q4)', async () => {
    const c = await portal(oriente);
    expect(c.status).toBe(200);
    const config = c.body.site.config as SiteConfig;
    expect(config.theme).toEqual(defaultSiteConfig('Transportes del Oriente').theme);
    expect(config.hero.title).toBe('Transportes del Oriente');
    expect(config.sections.filter((s) => s.enabled).map((s) => s.kind)).toEqual(
      expect.arrayContaining(['services', 'branches', 'contact']),
    );
    expect(config.sections.filter((s) => s.enabled).map((s) => s.kind)).not.toContain('faq');
    expect(config.branches).toEqual(orienteSite.branches);
    // Lo guardado no se pierde: el editor lo conserva para cuando contrate el módulo.
    expect((await as(oriente, 'get', '/api/v1/site')).body.published.config).toEqual(orienteSite);
  });

  it('publicar en una empresa no cambia el portal de las otras (caché por empresa)', async () => {
    const before = (await portal(naviera)).body;
    const next = { ...riberaSite, hero: { ...riberaSite.hero, title: 'Temporada de creciente' } };
    expect((await as(ribera, 'put', '/api/v1/site/draft', { config: next })).status).toBe(200);
    expect((await as(ribera, 'post', '/api/v1/site/publish')).status).toBe(200);
    const after = await portal(ribera);
    expect(after.body.site.version).toBe(2);
    expect(after.body.site.config.hero.title).toBe('Temporada de creciente');
    expect((await portal(naviera)).body).toEqual(before);
  });
});
