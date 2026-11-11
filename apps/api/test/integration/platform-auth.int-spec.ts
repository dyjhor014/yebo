/**
 * Fase 4.1 · Staff de YEBO: login en dos pasos con MFA TOTP obligatoria, sesión opaca del panel, enlaces de
 * configuración, gestión del staff, separación de realms (plataforma ≠ empresas) y auditoría.
 * PostgreSQL (rol yebo_backoffice) y Redis reales; reloj controlado.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import { createPrismaClient } from '../../src/infrastructure/database/create-prisma-client';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { Clock } from '../../src/modules/identity/clock';
import { PasswordHasher } from '../../src/modules/identity/password-hasher';
import { bootstrapSuperadmin } from '../../src/modules/platform-admin/staff.service';
import { hotp, totpStep } from '../../src/modules/platform-admin/totp';
import { testDbUrl, testPool } from '../support/db';

const DB = 'yebo_test';
const ADMIN = 'admin.yebo.pe';
const OTHER_HOST = 'empresa.yebo.test';
const PASSWORD = 'contraseña-larga-del-staff-1';

class FakeClock extends Clock {
  current = new Date('2026-11-10T15:00:00Z');
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Tarro de cookies (Secure): supertest habla HTTP, así que se gestionan a mano. */
class Jar {
  private readonly cookies = new Map<string, string>();
  absorb(res: request.Response): void {
    for (const line of (res.headers['set-cookie'] as unknown as string[] | undefined) ?? []) {
      const [pair] = line.split(';');
      const index = (pair ?? '').indexOf('=');
      const name = (pair ?? '').slice(0, index);
      const value = decodeURIComponent((pair ?? '').slice(index + 1));
      if (/Max-Age=0/.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  has(name: string): boolean {
    return this.cookies.has(name);
  }
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }
}

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

describe('Fase 4.1 · staff de YEBO (panel de administración)', () => {
  let app: INestApplication;
  let owner: Pool;
  const clock = new FakeClock();

  const http = () => request(app.getHttpServer());

  /** Petición al panel con las cookies del tarro y, en mutaciones, CSRF. */
  async function call(
    jar: Jar,
    method: 'get' | 'post',
    path: string,
    body?: object,
    host = ADMIN,
  ): Promise<request.Response> {
    let csrf = jar.get('__Host-yebo_csrf');
    if (method === 'post' && !csrf) {
      const res = await http().get('/api/v1/platform/auth/csrf').set('Host', host);
      jar.absorb(res);
      csrf = jar.get('__Host-yebo_csrf');
    }
    let req = http()[method](path).set('Host', host);
    if (jar.header()) req = req.set('Cookie', jar.header());
    if (method === 'post' && csrf) req = req.set('X-CSRF-Token', csrf);
    const res = await (body ? req.send(body) : req);
    jar.absorb(res);
    return res;
  }

  /** Login completo: contraseña + (alta de MFA | código). Devuelve el tarro con la sesión y el secreto TOTP. */
  async function signIn(
    email: string,
    password = PASSWORD,
    secret?: Buffer,
  ): Promise<{ jar: Jar; secret: Buffer }> {
    const jar = new Jar();
    const login = await call(jar, 'post', '/api/v1/platform/auth/login', { email, password });
    expect(login.status).toBe(200);
    let totp = secret;
    if (login.body.next === 'MFA_ENROLL') {
      const enroll = await call(jar, 'post', '/api/v1/platform/auth/mfa/enroll');
      expect(enroll.status).toBe(200);
      totp = base32Decode(enroll.body.secret);
      clock.advance(30_000);
      const activate = await call(jar, 'post', '/api/v1/platform/auth/mfa/activate', {
        code: hotp(totp, totpStep(clock.now())),
      });
      expect(activate.status).toBe(204);
    } else {
      if (!totp) throw new Error('falta el secreto TOTP');
      clock.advance(30_000);
      const verify = await call(jar, 'post', '/api/v1/platform/auth/mfa/verify', {
        code: hotp(totp, totpStep(clock.now())),
      });
      expect(verify.status).toBe(204);
    }
    return { jar, secret: totp as Buffer };
  }

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    await owner.query(
      'TRUNCATE platform_audit_logs, platform_setup_tokens, platform_sessions, platform_users, tenant_domains, tenants CASCADE',
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(nest, parseEnv(process.env), { swagger: false });
    await nest.init();
    await nest.listen(0, '127.0.0.1');
    app = nest;
    const redis = app.get(RedisService);
    const keys = [...(await redis.client.keys('rl:*plogin*')), ...(await redis.client.keys('rl:*pmfa*'))];
    if (keys.length > 0) await redis.client.del(...keys);

    const backoffice = createPrismaClient({
      connectionString: testDbUrl('backoffice', DB),
      max: 1,
      applicationName: 't',
      txMaxWaitMs: 10_000,
    });
    try {
      await bootstrapSuperadmin(backoffice, {
        email: 'ana@yebo.pe',
        fullName: 'Ana',
        passwordHash: await app.get(PasswordHasher).hash(PASSWORD),
      });
    } finally {
      await backoffice.$disconnect();
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.end();
  });

  it('el alta inicial solo funciona con la tabla vacía', async () => {
    const backoffice = createPrismaClient({
      connectionString: testDbUrl('backoffice', DB),
      max: 1,
      applicationName: 't',
      txMaxWaitMs: 10_000,
    });
    try {
      await expect(
        bootstrapSuperadmin(backoffice, { email: 'otro@yebo.pe', fullName: 'Otro', passwordHash: 'x' }),
      ).rejects.toThrow(/Ya existe staff/);
    } finally {
      await backoffice.$disconnect();
    }
  });

  describe('login en dos pasos con MFA obligatoria', () => {
    let secret: Buffer;

    it('la contraseña sola no abre sesión: primer acceso → alta de MFA', async () => {
      const jar = new Jar();
      const login = await call(jar, 'post', '/api/v1/platform/auth/login', {
        email: 'ana@yebo.pe',
        password: PASSWORD,
      });
      expect(login.body).toEqual({ next: 'MFA_ENROLL' });
      expect(jar.has('__Host-yebo_admin')).toBe(false);
      expect((await call(jar, 'get', '/api/v1/platform/auth/session')).status).toBe(401);
      const sessions = await owner.query('SELECT count(*)::int AS n FROM platform_sessions');
      expect(sessions.rows[0].n).toBe(0);

      const enroll = await call(jar, 'post', '/api/v1/platform/auth/mfa/enroll');
      expect(enroll.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/YEBO%20Admin:ana%40yebo\.pe\?secret=/);
      secret = base32Decode(enroll.body.secret);
      // El secreto se guarda cifrado (ADR-019), nunca en claro.
      const stored = await owner.query<{ c: Buffer }>(
        "SELECT mfa_secret_ciphertext AS c FROM platform_users WHERE email = 'ana@yebo.pe'",
      );
      expect(stored.rows[0]?.c.includes(secret)).toBe(false);

      expect((await call(jar, 'post', '/api/v1/platform/auth/mfa/activate', { code: '000000' })).status).toBe(
        401,
      );
      clock.advance(30_000);
      const ok = await call(jar, 'post', '/api/v1/platform/auth/mfa/activate', {
        code: hotp(secret, totpStep(clock.now())),
      });
      expect(ok.status).toBe(204);
      expect(jar.has('__Host-yebo_admin')).toBe(true);
      const session = await call(jar, 'get', '/api/v1/platform/auth/session');
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({ email: 'ana@yebo.pe', role: 'SUPERADMIN' });
      expect(session.body.permissions).toContain('platform.staff.manage');
    });

    it('un código TOTP no se puede reutilizar', async () => {
      const jar = new Jar();
      await call(jar, 'post', '/api/v1/platform/auth/login', { email: 'ana@yebo.pe', password: PASSWORD });
      // Mismo paso que la activación anterior: ya consumido.
      const replay = await call(jar, 'post', '/api/v1/platform/auth/mfa/verify', {
        code: hotp(secret, totpStep(clock.now())),
      });
      expect(replay.status).toBe(401);
      clock.advance(30_000);
      const fresh = await call(jar, 'post', '/api/v1/platform/auth/mfa/verify', {
        code: hotp(secret, totpStep(clock.now())),
      });
      expect(fresh.status).toBe(204);
    });

    it('dos verificaciones simultáneas con el mismo código: solo una abre sesión', async () => {
      const a = new Jar();
      const b = new Jar();
      await call(a, 'post', '/api/v1/platform/auth/login', { email: 'ana@yebo.pe', password: PASSWORD });
      await call(b, 'post', '/api/v1/platform/auth/login', { email: 'ana@yebo.pe', password: PASSWORD });
      clock.advance(30_000);
      const code = hotp(secret, totpStep(clock.now()));
      const before = (await owner.query('SELECT count(*)::int AS n FROM platform_sessions')).rows[0].n;
      const results = await Promise.all([
        call(a, 'post', '/api/v1/platform/auth/mfa/verify', { code }),
        call(b, 'post', '/api/v1/platform/auth/mfa/verify', { code }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 401]);
      const after = (await owner.query('SELECT count(*)::int AS n FROM platform_sessions')).rows[0].n;
      expect(after - before).toBe(1);
    });

    it('el paso de MFA caduca a los 5 minutos', async () => {
      const jar = new Jar();
      await call(jar, 'post', '/api/v1/platform/auth/login', { email: 'ana@yebo.pe', password: PASSWORD });
      clock.advance(6 * 60_000);
      const res = await call(jar, 'post', '/api/v1/platform/auth/mfa/verify', {
        code: hotp(secret, totpStep(clock.now())),
      });
      expect(res.status).toBe(401);
    });

    it('respuesta uniforme: correo inexistente y contraseña errónea dan lo mismo; tras 5 fallos, 429', async () => {
      const a = await call(new Jar(), 'post', '/api/v1/platform/auth/login', {
        email: 'nadie@yebo.pe',
        password: 'x',
      });
      // Cuenta REAL con contraseña errónea: misma respuesta que una cuenta inexistente (sin enumeración).
      const b = await call(new Jar(), 'post', '/api/v1/platform/auth/login', {
        email: 'ana@yebo.pe',
        password: 'mala',
      });
      expect([a.status, a.body.error.message]).toEqual([b.status, b.body.error.message]);
      for (let i = 0; i < 5; i++) {
        await call(new Jar(), 'post', '/api/v1/platform/auth/login', {
          email: 'bloqueo@yebo.pe',
          password: 'mala',
        });
      }
      const blocked = await call(new Jar(), 'post', '/api/v1/platform/auth/login', {
        email: 'bloqueo@yebo.pe',
        password: 'mala',
      });
      expect(blocked.status).toBe(429);
    });

    it('sesión: caduca por inactividad (30 min) y se cierra al salir', async () => {
      const { jar } = await signIn('ana@yebo.pe', PASSWORD, secret);
      clock.advance(31 * 60_000);
      expect((await call(jar, 'get', '/api/v1/platform/auth/session')).status).toBe(401);

      const again = await signIn('ana@yebo.pe', PASSWORD, secret);
      expect((await call(again.jar, 'post', '/api/v1/platform/auth/logout')).status).toBe(204);
      expect((await call(again.jar, 'get', '/api/v1/platform/auth/session')).status).toBe(401);
    });

    describe('realms separados', () => {
      it('las rutas del panel no existen en otro host (404)', async () => {
        const { jar } = await signIn('ana@yebo.pe', PASSWORD, secret);
        expect((await call(jar, 'get', '/api/v1/platform/auth/session', undefined, OTHER_HOST)).status).toBe(
          404,
        );
        expect((await call(jar, 'get', '/api/v1/platform/staff', undefined, 'cuentas.yebo.pe')).status).toBe(
          404,
        );
        expect(
          (
            await call(
              new Jar(),
              'post',
              '/api/v1/platform/auth/login',
              { email: 'a@b.pe', password: 'x' },
              OTHER_HOST,
            )
          ).status,
        ).toBe(404);
      });

      it('la sesión del staff no sirve en las rutas de empresa, ni un token de empresa en el panel', async () => {
        const { jar } = await signIn('ana@yebo.pe', PASSWORD, secret);
        await owner.query(
          `INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id_type, tax_id, status, updated_at)
           VALUES ('0190f0a0-0000-7000-8000-00000000a041', 'empresa', 'E', 'E', 'RUC', '20000000061', 'ACTIVE', now())
           ON CONFLICT DO NOTHING`,
        );
        await owner.query(
          `INSERT INTO tenant_domains (id, tenant_id, host, kind, is_primary, verification_status, verified_at, updated_at)
           VALUES (gen_random_uuid(), '0190f0a0-0000-7000-8000-00000000a041', $1, 'SUBDOMAIN', true, 'VERIFIED', now(), now())
           ON CONFLICT DO NOTHING`,
          [OTHER_HOST],
        );
        const cookie = `__Host-yebo_admin=${encodeURIComponent(jar.get('__Host-yebo_admin') ?? '')}`;
        const asTenant = await http()
          .get('/api/v1/auth/session')
          .set('Host', OTHER_HOST)
          .set('Cookie', cookie);
        expect(asTenant.status).toBe(401);
        const tenantCookie = await http()
          .get('/api/v1/platform/auth/session')
          .set('Host', ADMIN)
          .set('Cookie', '__Host-yebo_at=eyJhbGciOiJFZERTQSJ9.e30.x');
        expect(tenantCookie.status).toBe(401);
      });
    });

    describe('gestión del staff', () => {
      let anaJar: Jar;
      let billingId: string;
      let billingSecret: Buffer;

      beforeAll(async () => {
        anaJar = (await signIn('ana@yebo.pe', PASSWORD, secret)).jar;
      });

      it('alta con enlace de un solo uso (token en el fragmento #) y contraseña mínima', async () => {
        const created = await call(anaJar, 'post', '/api/v1/platform/invitations', {
          target: 'STAFF',
          email: 'Beto@YEBO.pe',
          fullName: 'Beto',
          role: 'BILLING',
        });
        expect(created.status).toBe(201);
        expect(created.body.link).toMatch(/^https:\/\/admin\.yebo\.pe\/configurar#token=[\w-]{43}$/);
        billingId = created.body.id;
        const token = created.body.link.split('#token=')[1];

        const anon = new Jar();
        expect(
          (await call(anon, 'post', '/api/v1/platform/auth/setup', { token, password: 'corta' })).status,
        ).toBe(400);
        expect(
          (await call(anon, 'post', '/api/v1/platform/auth/setup', { token, password: PASSWORD })).status,
        ).toBe(204);
        expect(
          (await call(anon, 'post', '/api/v1/platform/auth/setup', { token, password: PASSWORD })).status,
        ).toBe(401);

        const beto = await signIn('beto@yebo.pe');
        billingSecret = beto.secret;
        const me = await call(beto.jar, 'get', '/api/v1/platform/auth/session');
        expect(me.body.role).toBe('BILLING');
        expect(me.body.permissions).not.toContain('platform.staff.manage');
        expect((await call(beto.jar, 'get', '/api/v1/platform/staff')).status).toBe(403);
        expect(
          (
            await call(beto.jar, 'post', '/api/v1/platform/invitations', {
              target: 'STAFF',
              email: 'x@yebo.pe',
              fullName: 'X',
              role: 'VIEWER',
            })
          ).status,
        ).toBe(403);
      });

      it('correo duplicado → 409; mutación sin CSRF → 403', async () => {
        const dup = await call(anaJar, 'post', '/api/v1/platform/invitations', {
          target: 'STAFF',
          email: 'beto@yebo.pe',
          fullName: 'Beto 2',
          role: 'VIEWER',
        });
        expect(dup.status).toBe(409);
        const noCsrf = await http()
          .post('/api/v1/platform/invitations')
          .set('Host', ADMIN)
          .set('Cookie', `__Host-yebo_admin=${encodeURIComponent(anaJar.get('__Host-yebo_admin') ?? '')}`)
          .send({ target: 'STAFF', email: 'z@yebo.pe', fullName: 'Z', role: 'VIEWER' });
        expect(noCsrf.status).toBe(403);
      });

      it('desactivar corta sus sesiones de inmediato; nadie se desactiva a sí mismo', async () => {
        const beto = await signIn('beto@yebo.pe', PASSWORD, billingSecret);
        expect((await call(beto.jar, 'get', '/api/v1/platform/auth/session')).status).toBe(200);
        const self = await call(
          anaJar,
          'post',
          `/api/v1/platform/staff/${(await me(anaJar)).platformUserId}/disable`,
        );
        expect(self.status).toBe(403);
        const res = await call(anaJar, 'post', `/api/v1/platform/staff/${billingId}/disable`);
        expect(res.status).toBe(200);
        expect(res.body.revokedSessions).toBeGreaterThanOrEqual(1);
        expect((await call(beto.jar, 'get', '/api/v1/platform/auth/session')).status).toBe(401);
        // Cerradas de verdad (no solo bloqueadas por el estado del usuario).
        const live = await owner.query(
          'SELECT 1 FROM platform_sessions WHERE platform_user_id = $1 AND revoked_at IS NULL',
          [billingId],
        );
        expect(live.rowCount).toBe(0);
        const login = await call(new Jar(), 'post', '/api/v1/platform/auth/login', {
          email: 'beto@yebo.pe',
          password: PASSWORD,
        });
        expect(login.status).toBe(401);
      });

      it('nunca queda el sistema sin superadmin: dos superadmins que se desactivan a la vez → solo gana uno', async () => {
        const created = await call(anaJar, 'post', '/api/v1/platform/invitations', {
          target: 'STAFF',
          email: 'carla@yebo.pe',
          fullName: 'Carla',
          role: 'SUPERADMIN',
        });
        const token = created.body.link.split('#token=')[1];
        await call(new Jar(), 'post', '/api/v1/platform/auth/setup', { token, password: PASSWORD });
        const carla = await signIn('carla@yebo.pe');
        const anaId = (await me(anaJar)).platformUserId;
        const carlaId = created.body.id;
        const [a, b] = await Promise.all([
          call(anaJar, 'post', `/api/v1/platform/staff/${carlaId}/disable`),
          call(carla.jar, 'post', `/api/v1/platform/staff/${anaId}/disable`),
        ]);
        expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
        const active = await owner.query(
          "SELECT count(*)::int AS n FROM platform_users WHERE role = 'SUPERADMIN' AND status = 'ACTIVE'",
        );
        expect(active.rows[0].n).toBe(1);
      });

      it('cada acción queda auditada', async () => {
        const { rows } = await owner.query<{ action: string }>(
          'SELECT DISTINCT action FROM platform_audit_logs',
        );
        expect(rows.map((r) => r.action).sort()).toEqual(
          expect.arrayContaining([
            'staff.bootstrapped',
            'staff.created',
            'staff.disabled',
            'staff.login',
            'staff.logout',
            'staff.mfa_enabled',
            'staff.password_set',
          ]),
        );
      });
    });
  });

  async function me(jar: Jar): Promise<{ platformUserId: string }> {
    return (await call(jar, 'get', '/api/v1/platform/auth/session')).body;
  }
});
