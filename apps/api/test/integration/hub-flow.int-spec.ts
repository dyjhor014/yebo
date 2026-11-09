/**
 * Fase 3.2b · Hub de cuentas y sesión de empresa por HTTP (identity-and-sessions §3–8; ADR-022):
 * OAuth 2.0 Authorization Code + PKCE S256, cookies, CSRF, límites de intentos, reutilización del código,
 * renovación, cierre de sesión y cabeceras de seguridad. PostgreSQL y Redis reales; reloj controlado.
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ClsService } from 'nestjs-cls';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import type { RequestContextStore } from '../../src/infrastructure/context/request-context';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { AuthorizationCodeService } from '../../src/modules/identity/authorization-code.service';
import { Clock } from '../../src/modules/identity/clock';
import { PasswordHasher } from '../../src/modules/identity/password-hasher';
import { codeChallengeS256, newCodeVerifier } from '../../src/modules/identity/pkce';
import { SessionService } from '../../src/modules/identity/session.service';
import { TenantResolverService } from '../../src/modules/tenancy/tenant-resolver.service';
import { testBypassPool, testPool, RESET_TENANT_DATA } from '../support/db';

const DB = 'yebo_test';
const HUB = 'cuentas.yebo.pe';
const A = '0190f0a0-0000-7000-8000-00000000a003';
const B = '0190f0a0-0000-7000-8000-00000000b003';
const HOST_A = 'flujo-a.yebo.test';
const HOST_B = 'flujo-b.yebo.test';
const HOST_PENDING = 'flujo-pendiente.yebo.test';
const PASSWORD = 'correcta-caballo-bateria-grapa';

class FakeClock extends Clock {
  current = new Date();
  now(): Date {
    return this.current;
  }
}

/** Tarro de cookies mínimo por host (las cookies son Secure; supertest habla HTTP, así que se gestionan a mano). */
class Jar {
  private readonly cookies = new Map<string, string>();
  absorb(res: request.Response): void {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    for (const line of raw ?? []) {
      const [pair] = line.split(';');
      const index = (pair ?? '').indexOf('=');
      const name = (pair ?? '').slice(0, index);
      const value = decodeURIComponent((pair ?? '').slice(index + 1));
      if (/Max-Age=0/.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }
}

function setCookieLine(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((l) => l.startsWith(`${name}=`));
}

describe('Fase 3.2b · hub de cuentas y sesión de empresa (HTTP)', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let redis: RedisService;
  let cls: ClsService<RequestContextStore>;
  const clock = new FakeClock();
  let ana: string;
  let membershipA: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    seed = testBypassPool(DB, 2);
    await owner.query(RESET_TENANT_DATA);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(nest, parseEnv(process.env), { swagger: false });
    await nest.init();
    await nest.listen(0, '127.0.0.1');
    app = nest;
    redis = app.get(RedisService);
    cls = app.get(ClsService);
    for (const host of [HOST_A, HOST_B, HOST_PENDING]) await app.get(TenantResolverService).invalidate(host);

    await owner.query(
      `INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id_type, tax_id, status, updated_at) VALUES
         ($1, 'flujo-a', 'Transportes A S.A.C.', 'Transportes A', 'RUC', '20000000021', 'ACTIVE', now()),
         ($2, 'flujo-b', 'Naviera B S.A.C.', 'Naviera B', 'RUC', '20000000022', 'ACTIVE', now())`,
      [A, B],
    );
    await owner.query(
      `INSERT INTO tenant_domains (id, tenant_id, host, kind, is_primary, verification_status, verified_at, updated_at) VALUES
         (gen_random_uuid(), $1, $3, 'SUBDOMAIN', true, 'VERIFIED', now(), now()),
         (gen_random_uuid(), $2, $4, 'SUBDOMAIN', true, 'VERIFIED', now(), now()),
         (gen_random_uuid(), $1, $5, 'CUSTOM', NULL, 'PENDING', NULL, now())`,
      [A, B, HOST_A, HOST_B, HOST_PENDING],
    );
    const hash = await app.get(PasswordHasher).hash(PASSWORD);
    const users = await owner.query<{ id: string }>(
      `INSERT INTO users (id, email, password_hash, full_name, status, updated_at) VALUES
         (gen_random_uuid(), 'ana@example.com', $1, 'Ana', 'ACTIVE', now()),
         (gen_random_uuid(), 'beto@example.com', $1, 'Beto', 'ACTIVE', now()),
         (gen_random_uuid(), 'carla@example.com', $1, 'Carla', 'DISABLED', now()) RETURNING id`,
      [hash],
    );
    const [anaId, betoId] = users.rows.map((r) => r.id) as [string, string];
    ana = anaId;
    // tenant_memberships tiene RLS forzado: se siembra con el rol exclusivo de pruebas (ADR-034).
    const m = await seed.query<{ id: string }>(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at) VALUES
         (gen_random_uuid(), $1, $3, 'ACTIVE', now()),
         (gen_random_uuid(), $2, $3, 'ACTIVE', now()),
         (gen_random_uuid(), $1, $4, 'ACTIVE', now()) RETURNING id`,
      [A, B, anaId, betoId],
    );
    membershipA = m.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  beforeEach(async () => {
    clock.current = new Date();
    const keys = await redis.client.keys('rl:*');
    if (keys.length > 0) await redis.client.del(...keys);
  });

  // ---------------------------------------------------------------------------------------------
  // Utilidades del flujo
  // ---------------------------------------------------------------------------------------------

  async function hubLogin(
    hub: Jar,
    email = 'ana@example.com',
    password = PASSWORD,
  ): Promise<request.Response> {
    const csrf = await http().get('/api/v1/hub/csrf').set('Host', HUB);
    hub.absorb(csrf);
    const res = await http()
      .post('/api/v1/hub/login')
      .set('Host', HUB)
      .set('Cookie', hub.header())
      .set('X-CSRF-Token', csrf.body.csrfToken)
      .send({ email, password });
    hub.absorb(res);
    return res;
  }

  /** start en el dominio de la empresa → authorize en el hub → callback con code y state. */
  async function authorizeFor(
    host: string,
    tenant: Jar,
    hub: Jar,
    returnTo = '/panel',
  ): Promise<{ code: string; state: string; authorize: request.Response }> {
    const start = await http()
      .get(`/api/v1/auth/start?return=${encodeURIComponent(returnTo)}`)
      .set('Host', host);
    expect(start.status).toBe(302);
    tenant.absorb(start);
    const url = new URL(start.headers.location ?? '');
    expect(url.host).toBe(HUB);
    const authorize = await http()
      .get(`${url.pathname}${url.search}`)
      .set('Host', HUB)
      .set('Cookie', hub.header());
    const location = new URL(authorize.headers.location ?? '', `https://${HUB}`);
    return {
      code: location.searchParams.get('code') ?? '',
      state: location.searchParams.get('state') ?? '',
      authorize,
    };
  }

  async function redeem(host: string, tenant: Jar, code: string, state: string): Promise<request.Response> {
    const res = await http()
      .post('/api/v1/auth/token')
      .set('Host', host)
      .set('Cookie', tenant.header())
      .send({ code, state });
    tenant.absorb(res);
    return res;
  }

  async function loginToTenant(host = HOST_A): Promise<{ tenant: Jar; hub: Jar; res: request.Response }> {
    const hub = new Jar();
    const tenant = new Jar();
    expect((await hubLogin(hub)).status).toBe(204);
    const { code, state } = await authorizeFor(host, tenant, hub);
    const res = await redeem(host, tenant, code, state);
    return { tenant, hub, res };
  }

  // ---------------------------------------------------------------------------------------------

  describe('flujo completo (identity-and-sessions §3–4)', () => {
    it('start → hub sin sesión → login → código → canje por POST → sesión de empresa verificada', async () => {
      const hub = new Jar();
      const tenant = new Jar();

      const start = await http().get('/api/v1/auth/start?return=/panel').set('Host', HOST_A);
      expect(start.status).toBe(302);
      expect(setCookieLine(start, '__Host-yebo_auth')).toMatch(
        /Max-Age=600; Path=\/; Secure; SameSite=Lax; HttpOnly/,
      );
      tenant.absorb(start);
      const authorizeUrl = new URL(start.headers.location ?? '');
      expect(authorizeUrl.origin).toBe(`https://${HUB}`);
      expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorizeUrl.searchParams.has('redirect_uri')).toBe(false);

      const noSession = await http().get(`${authorizeUrl.pathname}${authorizeUrl.search}`).set('Host', HUB);
      expect(noSession.status).toBe(302);
      expect(noSession.headers.location).toMatch(/^\/login\?/);

      const login = await hubLogin(hub);
      expect(login.status).toBe(204);
      expect(setCookieLine(login, '__Host-yebo_hub')).toMatch(/Path=\/; Secure; SameSite=Lax; HttpOnly/);

      const authorize = await http()
        .get(`${authorizeUrl.pathname}${authorizeUrl.search}`)
        .set('Host', HUB)
        .set('Cookie', hub.header());
      expect(authorize.status).toBe(302);
      const callback = new URL(authorize.headers.location ?? '');
      expect(`${callback.origin}${callback.pathname}`).toBe(`https://${HOST_A}/auth/callback`);
      expect(callback.searchParams.get('state')).toBe(authorizeUrl.searchParams.get('state'));
      expect(callback.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const token = await redeem(
        HOST_A,
        tenant,
        callback.searchParams.get('code') ?? '',
        callback.searchParams.get('state') ?? '',
      );
      expect(token.status).toBe(200);
      expect(token.body.returnTo).toBe('/panel');
      expect(setCookieLine(token, '__Host-yebo_at')).toMatch(/Path=\/; Secure; SameSite=Lax; HttpOnly/);
      expect(setCookieLine(token, '__Secure-yebo_rt')).toMatch(
        /Path=\/api\/v1\/auth; Secure; SameSite=Strict; HttpOnly/,
      );
      expect(setCookieLine(token, '__Host-yebo_csrf')).not.toMatch(/HttpOnly/);
      expect(setCookieLine(token, '__Host-yebo_auth')).toMatch(/Max-Age=0/);

      const session = await http()
        .get('/api/v1/auth/session')
        .set('Host', HOST_A)
        .set('Cookie', tenant.header());
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({ userId: ana, tenantId: A, membershipId: membershipA });
    });

    it('cambio de empresa con un clic: con sesión en el hub, el código se emite sin pedir la contraseña', async () => {
      const { hub } = await loginToTenant(HOST_A);
      const tenantB = new Jar();
      const { code, state, authorize } = await authorizeFor(HOST_B, tenantB, hub, '/');
      expect(authorize.headers.location).toMatch(
        new RegExp(`^https://${HOST_B.replace(/\./g, '\\.')}/auth/callback\\?`),
      );
      const token = await redeem(HOST_B, tenantB, code, state);
      expect(token.status).toBe(200);
      const session = await http()
        .get('/api/v1/auth/session')
        .set('Host', HOST_B)
        .set('Cookie', tenantB.header());
      expect(session.body).toMatchObject({ tenantId: B });
    });

    it('sin membresía activa en la empresa → pantalla "sin acceso" del hub, sin código', async () => {
      const hub = new Jar();
      expect((await hubLogin(hub, 'beto@example.com')).status).toBe(204);
      const { authorize, code } = await authorizeFor(HOST_B, new Jar(), hub);
      expect(authorize.status).toBe(302);
      expect(authorize.headers.location).toBe(`/sin-acceso?tenant_host=${HOST_B}`);
      expect(code).toBe('');
    });

    it('el selector de empresa lista solo las membresías del propio usuario', async () => {
      const hub = new Jar();
      await hubLogin(hub);
      const res = await http().get('/api/v1/hub/me/memberships').set('Host', HUB).set('Cookie', hub.header());
      expect(res.body.memberships.map((m: { tradeName: string }) => m.tradeName)).toEqual([
        'Naviera B',
        'Transportes A',
      ]);
      const anonymous = await http().get('/api/v1/hub/me/memberships').set('Host', HUB);
      expect(anonymous.status).toBe(401);
    });
  });

  describe('código de autorización (RFC 6749 §4.1.2, RFC 7636)', () => {
    it('uso único: un segundo canje → 401 y se revoca la sesión emitida con el código', async () => {
      const hub = new Jar();
      const tenant = new Jar();
      await hubLogin(hub);
      const { code, state } = await authorizeFor(HOST_A, tenant, hub);
      const authCookie = tenant.get('__Host-yebo_auth') ?? '';
      expect((await redeem(HOST_A, tenant, code, state)).status).toBe(200);
      const live = await http()
        .get('/api/v1/auth/session')
        .set('Host', HOST_A)
        .set('Cookie', tenant.header());
      expect(live.status).toBe(200);

      const replay = new Jar();
      replay.set('__Host-yebo_auth', authCookie);
      expect((await redeem(HOST_A, replay, code, state)).status).toBe(401);
      const after = await http()
        .get('/api/v1/auth/session')
        .set('Host', HOST_A)
        .set('Cookie', tenant.header());
      expect(after.status).toBe(401);
      const { rows } = await owner.query(
        `SELECT ts.revoke_reason FROM authorization_codes ac JOIN tenant_sessions ts ON ts.id = ac.tenant_session_id
          WHERE ac.code_hash = sha256(convert_to($1, 'UTF8'))`,
        [code],
      );
      expect(rows).toEqual([{ revoke_reason: 'AUTH_CODE_REUSE' }]);
    });

    it('10 canjes concurrentes del mismo código: una sola sesión, y queda revocada por la reutilización', async () => {
      const hub = new Jar();
      const tenant = new Jar();
      await hubLogin(hub);
      const { code, state } = await authorizeFor(HOST_A, tenant, hub);
      const cookie = tenant.header();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          http().post('/api/v1/auth/token').set('Host', HOST_A).set('Cookie', cookie).send({ code, state }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 401)).toHaveLength(9);
      const { rows } = await owner.query(
        `SELECT count(ts.id)::int AS sessions, bool_and(ts.revoked_at IS NOT NULL) AS revoked
           FROM authorization_codes ac JOIN tenant_sessions ts ON ts.id = ac.tenant_session_id
          WHERE ac.code_hash = sha256(convert_to($1, 'UTF8'))`,
        [code],
      );
      expect(rows).toEqual([{ sessions: 1, revoked: true }]);
    });

    it('caduca a los 60 s', async () => {
      const hub = new Jar();
      const tenant = new Jar();
      await hubLogin(hub);
      const { code, state } = await authorizeFor(HOST_A, tenant, hub);
      clock.current = new Date(clock.current.getTime() + 61_000);
      expect((await redeem(HOST_A, tenant, code, state)).status).toBe(401);
    });

    it('`state` distinto del de la cookie → 401 sin consumir el código (protección contra login CSRF)', async () => {
      const hub = new Jar();
      const tenant = new Jar();
      await hubLogin(hub);
      const { code, state } = await authorizeFor(HOST_A, tenant, hub);
      const authCookie = tenant.get('__Host-yebo_auth') ?? '';
      expect((await redeem(HOST_A, tenant, code, 'X'.repeat(43))).status).toBe(401);
      const retry = new Jar();
      retry.set('__Host-yebo_auth', authCookie);
      expect((await redeem(HOST_A, retry, code, state)).status).toBe(200);
    });

    it('sin la cookie de la petición, o con la cookie alterada o de otro host → 401', async () => {
      const hub = new Jar();
      const tenant = new Jar();
      await hubLogin(hub);
      const { code, state } = await authorizeFor(HOST_A, tenant, hub);
      expect((await redeem(HOST_A, new Jar(), code, state)).status).toBe(401);
      const tampered = new Jar();
      tampered.set('__Host-yebo_auth', `${tenant.get('__Host-yebo_auth')}x`);
      expect((await redeem(HOST_A, tampered, code, state)).status).toBe(401);
      // La cookie de A presentada en B no vale (está ligada al host que inició el flujo).
      const otherHost = new Jar();
      otherHost.set('__Host-yebo_auth', tenant.get('__Host-yebo_auth') ?? '');
      expect((await redeem(HOST_B, otherHost, code, state)).status).toBe(401);
    });

    it('PKCE incorrecto o canje en otro tenant → 401, y el código queda consumido', async () => {
      const codes = app.get(AuthorizationCodeService);
      const sessions = app.get(SessionService);
      const identity = (await sessions.createIdentitySession({ userId: ana, authMethods: ['pwd'] })).id;
      const verifier = newCodeVerifier();
      const issue = () =>
        codes.issue({
          identitySessionId: identity,
          tenantHost: HOST_A,
          codeChallenge: codeChallengeS256(verifier),
        });
      const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
        cls.run(async () => {
          cls.set('tenantId', tenantId);
          return fn();
        });

      const wrongVerifier = await issue();
      if (wrongVerifier.kind !== 'issued') throw new Error('debía emitirse');
      await expect(
        inTenant(A, () =>
          codes.redeem({ code: wrongVerifier.code, codeVerifier: newCodeVerifier(), host: HOST_A }),
        ),
      ).rejects.toMatchObject({ httpStatus: 401 });
      await expect(
        inTenant(A, () => codes.redeem({ code: wrongVerifier.code, codeVerifier: verifier, host: HOST_A })),
      ).rejects.toMatchObject({ httpStatus: 401 });

      const otherTenant = await issue();
      if (otherTenant.kind !== 'issued') throw new Error('debía emitirse');
      await expect(
        inTenant(B, () => codes.redeem({ code: otherTenant.code, codeVerifier: verifier, host: HOST_B })),
      ).rejects.toMatchObject({ httpStatus: 401 });
      await expect(
        inTenant(A, () => codes.redeem({ code: otherTenant.code, codeVerifier: verifier, host: HOST_A })),
      ).rejects.toMatchObject({ httpStatus: 401 });
    });

    it('solo se guarda el SHA-256 del código; el redirect_uri es el derivado del host', async () => {
      const hub = new Jar();
      await hubLogin(hub);
      const { code } = await authorizeFor(HOST_A, new Jar(), hub);
      const { rows } = await owner.query(
        `SELECT redirect_uri, redemption_host::text AS host, code_challenge_method,
                code_hash = sha256(convert_to($1, 'UTF8')) AS hashed, octet_length(code_hash) AS len,
                (expires_at - created_at) AS ttl
           FROM authorization_codes WHERE code_hash = sha256(convert_to($1, 'UTF8'))`,
        [code],
      );
      expect(rows[0]).toMatchObject({
        redirect_uri: `https://${HOST_A}/auth/callback`,
        host: HOST_A,
        code_challenge_method: 'S256',
        hashed: true,
        len: 32,
      });
      expect(rows[0].ttl).toMatchObject({ minutes: 1 });
    });
  });

  describe('punto de autorización: parámetros cerrados', () => {
    const base = {
      response_type: 'code',
      tenant_host: HOST_A,
      state: 'S'.repeat(43),
      code_challenge: 'C'.repeat(43),
      code_challenge_method: 'S256',
    };
    const authorize = (params: Record<string, string>) =>
      http()
        .get(`/api/v1/hub/authorize?${new URLSearchParams(params)}`)
        .set('Host', HUB);

    it.each([
      ['redirect_uri enviado por el cliente', { ...base, redirect_uri: 'https://evil.example/cb' }],
      ['flujo implícito (response_type=token)', { ...base, response_type: 'token' }],
      ['PKCE plain', { ...base, code_challenge_method: 'plain' }],
      ['sin PKCE', { response_type: 'code', tenant_host: HOST_A, state: base.state }],
      ['reto con formato inválido', { ...base, code_challenge: 'corto' }],
      ['host desconocido', { ...base, tenant_host: 'desconocido.yebo.test' }],
      ['dominio no verificado', { ...base, tenant_host: HOST_PENDING }],
    ])('%s → 400 sin redirigir', async (_name, params) => {
      const res = await authorize(params as Record<string, string>);
      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it('cabeceras: no-store, no-referrer, frame-ancestors none y X-Frame-Options DENY', async () => {
      const res = await authorize(base);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
    });
  });

  describe('login del hub (security.md §1)', () => {
    it('respuesta idéntica para contraseña errónea, cuenta inexistente o deshabilitada', async () => {
      const bodies = [];
      for (const [email, password] of [
        ['ana@example.com', 'incorrecta-del-todo'],
        ['nadie@example.com', PASSWORD],
        ['carla@example.com', PASSWORD],
      ] as const) {
        const res = await hubLogin(new Jar(), email, password);
        expect(res.status).toBe(401);
        expect(setCookieLine(res, '__Host-yebo_hub')).toBeUndefined();
        bodies.push({ code: res.body.error.code, message: res.body.error.message });
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    });

    it('el correo no distingue mayúsculas', async () => {
      expect((await hubLogin(new Jar(), 'ANA@Example.com')).status).toBe(204);
    });

    it('sin token CSRF o con uno distinto → 403', async () => {
      const csrf = await http().get('/api/v1/hub/csrf').set('Host', HUB);
      const jar = new Jar();
      jar.absorb(csrf);
      const noHeader = await http()
        .post('/api/v1/hub/login')
        .set('Host', HUB)
        .set('Cookie', jar.header())
        .send({ email: 'ana@example.com', password: PASSWORD });
      expect(noHeader.status).toBe(403);
      const wrong = await http()
        .post('/api/v1/hub/login')
        .set('Host', HUB)
        .set('Cookie', jar.header())
        .set('X-CSRF-Token', 'Z'.repeat(43))
        .send({ email: 'ana@example.com', password: PASSWORD });
      expect(wrong.status).toBe(403);
    });

    it('5 fallos por cuenta → 429, incluso con la contraseña correcta; igual para una cuenta inexistente', async () => {
      for (let i = 0; i < 5; i++)
        expect((await hubLogin(new Jar(), 'ana@example.com', 'mala-1234567')).status).toBe(401);
      expect((await hubLogin(new Jar(), 'ana@example.com', PASSWORD)).status).toBe(429);
      for (let i = 0; i < 5; i++)
        expect((await hubLogin(new Jar(), 'fantasma@example.com', 'mala-1234567')).status).toBe(401);
      expect((await hubLogin(new Jar(), 'fantasma@example.com', 'mala-1234567')).status).toBe(429);
    });

    it('límite por IP: 30 intentos por ventana', async () => {
      for (let i = 0; i < 30; i++) await hubLogin(new Jar(), `x${i}@example.com`, 'mala-1234567');
      expect((await hubLogin(new Jar(), 'ana@example.com', PASSWORD)).status).toBe(429);
    });

    it('cookie del hub alterada → como si no hubiera sesión', async () => {
      const hub = new Jar();
      await hubLogin(hub);
      const forged = new Jar();
      const [id] = (hub.get('__Host-yebo_hub') ?? '').split('.');
      forged.set('__Host-yebo_hub', `${id}.${'A'.repeat(43)}`);
      const res = await http()
        .get('/api/v1/hub/me/memberships')
        .set('Host', HUB)
        .set('Cookie', forged.header());
      expect(res.status).toBe(401);
    });
  });

  describe('sesión de empresa: renovación, cierre y verificación', () => {
    it('refresh exige CSRF, rota las cookies y una reutilización fuera de la gracia revoca la sesión', async () => {
      const { tenant } = await loginToTenant(HOST_A);
      const oldRefresh = tenant.get('__Secure-yebo_rt') ?? '';
      const noCsrf = await http()
        .post('/api/v1/auth/refresh')
        .set('Host', HOST_A)
        .set('Cookie', tenant.header());
      expect(noCsrf.status).toBe(403);

      const ok = await http()
        .post('/api/v1/auth/refresh')
        .set('Host', HOST_A)
        .set('Cookie', tenant.header())
        .set('X-CSRF-Token', tenant.get('__Host-yebo_csrf') ?? '');
      expect(ok.status).toBe(200);
      tenant.absorb(ok);
      expect(tenant.get('__Secure-yebo_rt')).not.toBe(oldRefresh);

      clock.current = new Date(clock.current.getTime() + 21_000);
      const replay = new Jar();
      replay.set('__Secure-yebo_rt', oldRefresh);
      replay.set('__Host-yebo_csrf', tenant.get('__Host-yebo_csrf') ?? '');
      const reuse = await http()
        .post('/api/v1/auth/refresh')
        .set('Host', HOST_A)
        .set('Cookie', replay.header())
        .set('X-CSRF-Token', replay.get('__Host-yebo_csrf') ?? '');
      expect(reuse.status).toBe(401);
      expect(setCookieLine(reuse, '__Host-yebo_at')).toMatch(/Max-Age=0/);
      const session = await http()
        .get('/api/v1/auth/session')
        .set('Host', HOST_A)
        .set('Cookie', tenant.header());
      expect(session.status).toBe(401);
    });

    it('logout de la empresa revoca su sesión y devuelve el cierre del hub; el hub revoca todas', async () => {
      const { tenant, hub } = await loginToTenant(HOST_A);
      const tenantB = new Jar();
      const { code, state } = await authorizeFor(HOST_B, tenantB, hub);
      await redeem(HOST_B, tenantB, code, state);

      const logout = await http()
        .post('/api/v1/auth/logout')
        .set('Host', HOST_A)
        .set('Cookie', tenant.header())
        .set('X-CSRF-Token', tenant.get('__Host-yebo_csrf') ?? '');
      expect(logout.status).toBe(200);
      expect(logout.body.hubLogoutUrl).toBe(`https://${HUB}/salir`);
      expect(
        (await http().get('/api/v1/auth/session').set('Host', HOST_A).set('Cookie', tenant.header())).status,
      ).toBe(401);
      expect(
        (await http().get('/api/v1/auth/session').set('Host', HOST_B).set('Cookie', tenantB.header())).status,
      ).toBe(200);

      const csrf = await http().get('/api/v1/hub/csrf').set('Host', HUB).set('Cookie', hub.header());
      hub.absorb(csrf);
      const hubLogout = await http()
        .post('/api/v1/hub/logout')
        .set('Host', HUB)
        .set('Cookie', hub.header())
        .set('X-CSRF-Token', csrf.body.csrfToken);
      expect(hubLogout.status).toBe(204);
      expect(
        (await http().get('/api/v1/auth/session').set('Host', HOST_B).set('Cookie', tenantB.header())).status,
      ).toBe(401);
      const { authorize } = await authorizeFor(HOST_A, new Jar(), hub);
      expect(authorize.headers.location).toMatch(/^\/login\?/);
    });

    it('un access token de A presentado en el host de B → 401', async () => {
      const { tenant } = await loginToTenant(HOST_A);
      const res = await http().get('/api/v1/auth/session').set('Host', HOST_B).set('Cookie', tenant.header());
      expect(res.status).toBe(401);
    });

    it('permisos cambiados → 401 PERMISSIONS_CHANGED; tras renovar, el token vuelve a valer', async () => {
      const { tenant } = await loginToTenant(HOST_A);
      await seed.query(
        `UPDATE tenant_memberships SET permissions_version = permissions_version + 1 WHERE id = $1`,
        [membershipA],
      );
      const stale = await http()
        .get('/api/v1/auth/session')
        .set('Host', HOST_A)
        .set('Cookie', tenant.header());
      expect(stale.status).toBe(401);
      expect(stale.body.error.code).toBe('PERMISSIONS_CHANGED');
      const renewed = await http()
        .post('/api/v1/auth/refresh')
        .set('Host', HOST_A)
        .set('Cookie', tenant.header())
        .set('X-CSRF-Token', tenant.get('__Host-yebo_csrf') ?? '');
      tenant.absorb(renewed);
      expect(
        (await http().get('/api/v1/auth/session').set('Host', HOST_A).set('Cookie', tenant.header())).status,
      ).toBe(200);
    });

    it('la ruta de retorno solo admite rutas internas (sin redirección abierta)', async () => {
      for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example', 'panel']) {
        const start = await http()
          .get(`/api/v1/auth/start?return=${encodeURIComponent(evil)}`)
          .set('Host', HOST_A);
        const raw = decodeURIComponent(
          (setCookieLine(start, '__Host-yebo_auth') ?? '').split(';')[0]?.split('=')[1] ?? '',
        );
        const payload = JSON.parse(Buffer.from(raw.split('.')[0] ?? '', 'base64url').toString());
        expect(payload.r).toBe('/');
      }
    });
  });

  describe('separación de hosts', () => {
    it('las rutas del hub solo existen en el host del hub, y las de empresa solo en dominios de empresa', async () => {
      expect((await http().get('/api/v1/hub/csrf').set('Host', HOST_A)).status).toBe(404);
      expect((await http().get('/api/v1/auth/start').set('Host', HUB)).status).toBe(404);
      expect((await http().get('/api/v1/auth/start').set('Host', HOST_PENDING)).status).toBe(404);
    });
  });
});
