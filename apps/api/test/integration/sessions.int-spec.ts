/**
 * Fase 3.2a · Sesiones, refresh tokens y revocación (ADR-009; identity-and-sessions §6–8, §11).
 * PostgreSQL y Redis reales; rol dedicado yebo_identity; reloj controlado para la gracia y las expiraciones.
 */
import { createHash } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import type { RequestContextStore } from '../../src/infrastructure/context/request-context';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { AccessTokenService } from '../../src/modules/identity/access-token.service';
import { Clock } from '../../src/modules/identity/clock';
import { IdentityPrismaService } from '../../src/modules/identity/identity-prisma.service';
import { SessionService, type IssuedTokens } from '../../src/modules/identity/session.service';
import { decryptSuccessor } from '../../src/modules/identity/successor-crypto';
import { testBypassPool, testPool } from '../support/db';

const DB = 'yebo_test';
const A = '0190f0a0-0000-7000-8000-00000000a002';
const B = '0190f0a0-0000-7000-8000-00000000b002';
const HOST_A = 'sesiones-a.yebo.test';
const HOST_B = 'sesiones-b.yebo.test';
const HOST_A_PENDING = 'pendiente-a.yebo.test';
const GRACE_MS = 20_000;

class FakeClock extends Clock {
  current = new Date();
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

describe('Fase 3.2a · sesiones y refresh tokens (PostgreSQL y Redis reales, rol yebo_identity)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let sessions: SessionService;
  let tokens: AccessTokenService;
  let redis: RedisService;
  let cls: ClsService<RequestContextStore>;
  let owner: Pool;
  let appPool: Pool;
  let seed: Pool;
  let identityPool: Pool;
  const clock = new FakeClock();
  let user: string;
  let otherUser: string;
  let membershipA: string;
  let membershipB: string;
  let otherMembershipA: string;

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    appPool = testPool('app', DB, 2);
    seed = testBypassPool(DB, 2);
    identityPool = testPool('identity', DB, 2);
    await owner.query(
      'TRUNCATE authorization_codes, refresh_tokens, tenant_sessions, identity_sessions, membership_roles, role_permissions, roles, tenant_memberships, users, permissions, role_templates, tenant_domains, tenants',
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    await app.init();
    // Las pruebas pueden obtener el proveedor privado del módulo (strict: false); el código de src no (DI + ESLint).
    db = app.get(IdentityPrismaService, { strict: false }).client;
    sessions = app.get(SessionService);
    tokens = app.get(AccessTokenService);
    redis = app.get(RedisService);
    cls = app.get(ClsService);

    // Datos de partida con el propietario: yebo_identity no puede escribir tenants, dominios, usuarios ni membresías.
    await owner.query(
      `INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id_type, tax_id, status, updated_at) VALUES
         ($1, 'sesiones-a', 'A S.A.C.', 'A', 'RUC', '20000000011', 'ACTIVE', now()),
         ($2, 'sesiones-b', 'B S.A.C.', 'B', 'RUC', '20000000012', 'ACTIVE', now())`,
      [A, B],
    );
    await owner.query(
      `INSERT INTO tenant_domains (id, tenant_id, host, kind, is_primary, verification_status, verified_at, updated_at) VALUES
         (gen_random_uuid(), $1, $3, 'SUBDOMAIN', true, 'VERIFIED', now(), now()),
         (gen_random_uuid(), $2, $4, 'SUBDOMAIN', true, 'VERIFIED', now(), now()),
         (gen_random_uuid(), $1, $5, 'CUSTOM', NULL, 'PENDING', NULL, now())`,
      [A, B, HOST_A, HOST_B, HOST_A_PENDING],
    );
    const users = await owner.query<{ id: string }>(
      `INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES
         (gen_random_uuid(), 'ana@example.com', 'x', 'Ana', now()),
         (gen_random_uuid(), 'beto@example.com', 'x', 'Beto', now()) RETURNING id`,
    );
    [user, otherUser] = users.rows.map((r) => r.id) as [string, string];
    // tenant_memberships tiene RLS FORZADO (incluso para el propietario): se siembra con el rol de pruebas (ADR-034).
    const memberships = await seed.query<{ id: string }>(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at) VALUES
         (gen_random_uuid(), $1, $3, 'ACTIVE', now()),
         (gen_random_uuid(), $2, $3, 'ACTIVE', now()),
         (gen_random_uuid(), $1, $4, 'ACTIVE', now()) RETURNING id`,
      [A, B, user, otherUser],
    );
    [membershipA, membershipB, otherMembershipA] = memberships.rows.map((r) => r.id) as [
      string,
      string,
      string,
    ];
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), appPool.end(), seed.end(), identityPool.end()]);
  });

  beforeEach(() => {
    clock.current = new Date();
  });

  async function login(userId = user): Promise<string> {
    return (await sessions.createIdentitySession({ userId, authMethods: ['pwd'], ip: '203.0.113.7' })).id;
  }

  async function open(host = HOST_A, identity?: string): Promise<IssuedTokens> {
    return sessions.openTenantSession({ identitySessionId: identity ?? (await login()), host });
  }

  /** Ejecuta `fn` como si fuera un request de la empresa `tenantId` (TenantHostGuard fija el tenant en el contexto). */
  function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return cls.run(async () => {
      cls.set('tenantId', tenantId);
      return fn();
    });
  }

  async function sessionRow(id: string): Promise<{ revoked_at: Date | null; revoke_reason: string | null }> {
    const { rows } = await owner.query(
      `SELECT revoked_at, revoke_reason FROM tenant_sessions WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function setMembership(id: string, status: string): Promise<void> {
    await seed.query(`UPDATE tenant_memberships SET status = $2 WHERE id = $1`, [id, status]);
  }

  describe('privilegios (PostgreSQL)', () => {
    const sessionTables = ['identity_sessions', 'tenant_sessions', 'refresh_tokens', 'authorization_codes'];

    it('yebo_app y yebo_platform no tienen ningún acceso a las tablas de sesión', async () => {
      const platform = testPool('platform', DB, 1);
      try {
        for (const pool of [appPool, platform]) {
          for (const t of sessionTables) {
            await expect(pool.query(`SELECT 1 FROM ${t} LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
          }
        }
      } finally {
        await platform.end();
      }
    });

    it('yebo_identity: SELECT/INSERT/UPDATE en sesiones; sin DELETE ni TRUNCATE', async () => {
      for (const t of sessionTables) {
        await expect(identityPool.query(`SELECT count(*) FROM ${t}`)).resolves.toBeDefined();
        await expect(identityPool.query(`DELETE FROM ${t}`)).rejects.toMatchObject({ code: '42501' });
        await expect(identityPool.query(`TRUNCATE ${t}`)).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('yebo_identity: solo lectura de users, tenant_memberships y tenant_domains', async () => {
      for (const t of ['users', 'tenant_memberships', 'tenant_domains']) {
        await expect(identityPool.query(`SELECT count(*) FROM ${t}`)).resolves.toBeDefined();
        await expect(identityPool.query(`UPDATE ${t} SET updated_at = now()`)).rejects.toMatchObject({
          code: '42501',
        });
        await expect(identityPool.query(`DELETE FROM ${t}`)).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('yebo_identity no accede a tenants ni a datos de negocio o configuración de las empresas', async () => {
      for (const t of [
        'tenants',
        'roles',
        'role_permissions',
        'membership_roles',
        'permissions',
        'role_templates',
      ]) {
        await expect(identityPool.query(`SELECT 1 FROM ${t} LIMIT 1`)).rejects.toMatchObject({
          code: '42501',
        });
      }
    });

    it('la política de lectura de membresías es solo de yebo_identity; yebo_app sigue aislado por tenant (RLS)', async () => {
      const { rows } = await identityPool.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM tenant_memberships WHERE user_id = $1 ORDER BY 1`,
        [user],
      );
      expect(rows.map((r) => r.tenant_id)).toEqual([A, B].sort());
      // yebo_app sin contexto de tenant: 0 filas (ADR-025), la política nueva no le alcanza.
      const appRows = await appPool.query(`SELECT count(*)::int AS n FROM tenant_memberships`);
      expect(appRows.rows[0].n).toBe(0);
      const { rows: policies } = await owner.query(
        `SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies WHERE tablename = 'tenant_memberships' ORDER BY 1`,
      );
      expect(policies).toEqual([
        { policyname: 'identity_read_memberships', cmd: 'SELECT', roles: ['yebo_identity'] },
        { policyname: 'tenant_isolation', cmd: 'ALL', roles: ['public'] },
      ]);
    });

    it('rol yebo_identity: sin BYPASSRLS, sin superusuario, sin crear roles ni bases', async () => {
      const { rows } = await owner.query(
        `SELECT rolbypassrls, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'yebo_identity'`,
      );
      expect(rows).toEqual([
        { rolbypassrls: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false },
      ]);
    });

    it('FK compuestas: la sesión de empresa no puede usar la membresía de otro usuario ni una sesión de identidad ajena', async () => {
      const identity = await login();
      const base = {
        identitySessionId: identity,
        userId: user,
        tenantId: A,
        host: HOST_A,
        lastSeenAt: new Date(),
        idleExpiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt: new Date(Date.now() + 120_000),
      };
      await expect(
        db.tenantSession.create({ data: { ...base, membershipId: membershipB } }),
      ).rejects.toMatchObject({
        code: 'P2003',
      });
      await expect(
        db.tenantSession.create({ data: { ...base, membershipId: otherMembershipA } }),
      ).rejects.toMatchObject({ code: 'P2003' });
      await expect(
        db.tenantSession.create({ data: { ...base, userId: otherUser, membershipId: otherMembershipA } }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('CHECK: hash de 32 bytes, revocación con motivo y sucesor cifrado solo en tokens rotados y de 61 bytes', async () => {
      const { sessionId } = await open();
      await expect(
        owner.query(
          `INSERT INTO refresh_tokens (id, tenant_session_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, '\\x00', now())`,
          [sessionId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        owner.query(`UPDATE tenant_sessions SET revoked_at = now() WHERE id = $1`, [sessionId]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        owner.query(`UPDATE refresh_tokens SET successor_ciphertext = '\\x01' WHERE tenant_session_id = $1`, [
          sessionId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('apertura de la sesión de empresa', () => {
    it('emite un access token EdDSA con sub, sid, tid, mid, ver y aud, y guarda solo el SHA-256 del refresh token', async () => {
      const issued = await open();
      const claims = tokens.verify(issued.accessToken);
      expect(claims).toMatchObject({
        sub: user,
        sid: issued.sessionId,
        tid: A,
        mid: membershipA,
        ver: 1,
        aud: 'yebo-tenant-api',
      });
      expect(issued.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const stored = await db.refreshToken.findMany({ where: { tenantSessionId: issued.sessionId } });
      expect(stored).toHaveLength(1);
      expect(Buffer.from(stored[0]?.tokenHash ?? []).equals(sha256(issued.refreshToken))).toBe(true);
    });

    it('el tenant se deriva del host: sin membresía ACTIVE, usuario deshabilitado o host no verificado → 401', async () => {
      const identity = await login(otherUser);
      // otherUser no tiene membresía en B: el host de B no sirve aunque la sesión de identidad sea válida.
      await expect(open(HOST_B, identity)).rejects.toMatchObject({ httpStatus: 401 });
      await expect(open(HOST_A_PENDING, identity)).rejects.toMatchObject({ httpStatus: 401 });
      await expect(open('desconocido.yebo.test', identity)).rejects.toMatchObject({ httpStatus: 401 });

      const own = await login();
      await setMembership(membershipA, 'SUSPENDED');
      await expect(open(HOST_A, own)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      await setMembership(membershipA, 'ACTIVE');
      await owner.query(`UPDATE users SET status = 'DISABLED' WHERE id = $1`, [user]);
      await expect(open(HOST_A, own)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      await owner.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [user]);
    });

    it('si el request tiene tenant en su contexto, debe coincidir con el del host', async () => {
      const identity = await login();
      await expect(inTenant(B, () => open(HOST_A, identity))).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      await expect(inTenant(A, () => open(HOST_A, identity))).resolves.toMatchObject({
        sessionId: expect.any(String),
      });
    });

    it('el estado del tenant no bloquea la sesión (identity-and-sessions §8; ADR-023)', async () => {
      await owner.query(`UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1`, [A]);
      const issued = await open();
      await expect(sessions.checkSession(issued.sessionId)).resolves.toMatchObject({ active: true });
      await owner.query(`UPDATE tenants SET status = 'ACTIVE' WHERE id = $1`, [A]);
    });
  });

  describe('rotación del refresh token (identity-and-sessions §6)', () => {
    it('cada uso devuelve un refresh nuevo; el anterior queda rotado con el sucesor CIFRADO, nunca en claro', async () => {
      const first = await open();
      const second = await sessions.refresh(first.refreshToken, HOST_A);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.sessionId).toBe(first.sessionId);
      const chain = await db.refreshToken.findMany({
        where: { tenantSessionId: first.sessionId },
        orderBy: { createdAt: 'asc' },
      });
      expect(chain).toHaveLength(2);
      const [root, child] = chain;
      expect(root?.rotatedAt).not.toBeNull();
      expect(child?.parentId).toBe(root?.id);
      const ciphertext = Buffer.from(root?.successorCiphertext ?? []);
      expect(ciphertext).toHaveLength(61);
      // El sucesor en claro no aparece en la fila; solo se descifra con el token padre.
      expect(ciphertext.includes(Buffer.from(second.refreshToken, 'base64url'))).toBe(false);
      const binding = { parentId: root?.id ?? '', sessionId: first.sessionId };
      expect(decryptSuccessor(first.refreshToken, ciphertext, binding)).toBe(second.refreshToken);
      expect(decryptSuccessor(second.refreshToken, ciphertext, binding)).toBeNull();
      // Nada en Redis.
      expect(await redis.client.keys('rt:*')).toEqual([]);
      expect(await redis.client.keys('tsess:*')).toEqual([]);
    });

    it('ventana de gracia: 10 refrescos concurrentes del mismo token reciben EL MISMO sucesor, sin revocar', async () => {
      const first = await open();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => sessions.refresh(first.refreshToken, HOST_A)),
      );
      expect(new Set(results.map((r) => r.refreshToken)).size).toBe(1);
      expect(await db.refreshToken.count({ where: { tenantSessionId: first.sessionId } })).toBe(2);
      expect((await sessionRow(first.sessionId)).revoked_at).toBeNull();

      clock.advance(GRACE_MS - 1000);
      const late = await sessions.refresh(first.refreshToken, HOST_A);
      expect(late.refreshToken).toBe(results[0]?.refreshToken);
    });

    it('reutilización fuera de la ventana de gracia → se revoca la familia completa y se borran los cifrados', async () => {
      const first = await open();
      const second = await sessions.refresh(first.refreshToken, HOST_A);
      clock.advance(GRACE_MS + 1000);
      await expect(sessions.refresh(first.refreshToken, HOST_A)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      expect(await sessionRow(first.sessionId)).toMatchObject({ revoke_reason: 'REFRESH_REUSE' });
      await expect(sessions.refresh(second.refreshToken, HOST_A)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      await expect(sessions.checkSession(first.sessionId)).resolves.toEqual({ active: false });
      expect(
        await db.refreshToken.count({
          where: { tenantSessionId: first.sessionId, successorCiphertext: { not: null } },
        }),
      ).toBe(0);
    });

    it('al rotar el sucesor fuera de la gracia de su padre, el cifrado del padre se elimina', async () => {
      const first = await open();
      const second = await sessions.refresh(first.refreshToken, HOST_A);
      clock.advance(GRACE_MS + 1000);
      await sessions.refresh(second.refreshToken, HOST_A);
      const root = await db.refreshToken.findFirst({
        where: { tenantSessionId: first.sessionId, parentId: null },
      });
      expect(root?.successorCiphertext).toBeNull();
    });

    it('un refresh token presentado en otro dominio, inventado o con formato inválido → 401, sin revocar', async () => {
      const first = await open();
      await expect(sessions.refresh(first.refreshToken, HOST_B)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      await expect(sessions.refresh('A'.repeat(43), HOST_A)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      await expect(sessions.refresh('corto', HOST_A)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect((await sessionRow(first.sessionId)).revoked_at).toBeNull();
      await expect(sessions.refresh(first.refreshToken, HOST_A)).resolves.toBeDefined();
    });

    it('un cifrado manipulado dentro de la gracia → 401 (no se entrega un sucesor no auténtico)', async () => {
      const first = await open();
      await sessions.refresh(first.refreshToken, HOST_A);
      await owner.query(
        `UPDATE refresh_tokens SET successor_ciphertext = set_byte(successor_ciphertext, 30, get_byte(successor_ciphertext, 30) # 1)
          WHERE tenant_session_id = $1 AND parent_id IS NULL`,
        [first.sessionId],
      );
      await expect(sessions.refresh(first.refreshToken, HOST_A)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    });

    it('expiraciones: inactividad, máximo absoluto y caducidad del propio refresh token', async () => {
      const idle = await open();
      clock.advance(720 * 60_000 + 1000);
      await expect(sessions.checkSession(idle.sessionId)).resolves.toEqual({ active: false });
      await expect(sessions.refresh(idle.refreshToken, HOST_A)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });

      clock.current = new Date();
      const absolute = await open();
      await owner.query(
        `UPDATE tenant_sessions SET idle_expires_at = now() + interval '1 minute', absolute_expires_at = now() + interval '1 minute' WHERE id = $1`,
        [absolute.sessionId],
      );
      clock.advance(2 * 60_000);
      await expect(sessions.checkSession(absolute.sessionId)).resolves.toEqual({ active: false });
      await expect(sessions.refresh(absolute.refreshToken, HOST_A)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });

      clock.current = new Date();
      const expiredToken = await open();
      await owner.query(
        `UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE tenant_session_id = $1`,
        [expiredToken.sessionId],
      );
      await expect(sessions.refresh(expiredToken.refreshToken, HOST_A)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    });
  });

  describe('verificación por request y revocación (identity-and-sessions §7–8)', () => {
    it('la revocación se aplica en la siguiente verificación (siempre en PostgreSQL)', async () => {
      const issued = await open();
      await expect(sessions.checkSession(issued.sessionId)).resolves.toMatchObject({
        active: true,
        tenantId: A,
      });
      await expect(
        inTenant(A, () => sessions.revokeTenantSession(issued.sessionId, 'ADMIN_REVOKED')),
      ).resolves.toBe(true);
      await expect(sessions.checkSession(issued.sessionId)).resolves.toEqual({ active: false });
      // El access token sigue siendo criptográficamente válido: lo invalida la verificación de sesión.
      expect(tokens.verify(issued.accessToken).sid).toBe(issued.sessionId);
    });

    it('cambios directos de membresía, usuario o permisos se reflejan en la siguiente verificación', async () => {
      const issued = await open();
      await setMembership(membershipA, 'SUSPENDED');
      await expect(sessions.checkSession(issued.sessionId)).resolves.toEqual({ active: false });
      await setMembership(membershipA, 'ACTIVE');
      await owner.query(`UPDATE users SET status = 'DISABLED' WHERE id = $1`, [user]);
      await expect(sessions.checkSession(issued.sessionId)).resolves.toEqual({ active: false });
      await owner.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [user]);
      await seed.query(
        `UPDATE tenant_memberships SET permissions_version = permissions_version + 1 WHERE id = $1`,
        [membershipA],
      );
      const check = await sessions.checkSession(issued.sessionId);
      const { rows } = await seed.query(`SELECT permissions_version FROM tenant_memberships WHERE id = $1`, [
        membershipA,
      ]);
      expect(check).toMatchObject({ active: true, permissionsVersion: rows[0].permissions_version });
    });

    it('sesión de identidad revocada por cualquier vía → sus hijas no se renuevan ni se verifican (hallazgo M1)', async () => {
      const identity = await login();
      const child = await open(HOST_A, identity);
      await owner.query(
        `UPDATE identity_sessions SET revoked_at = now(), revoke_reason = 'LOGOUT' WHERE id = $1`,
        [identity],
      );
      await expect(sessions.refresh(child.refreshToken, HOST_A)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      await expect(sessions.checkSession(child.sessionId)).resolves.toEqual({ active: false });
    });

    it('carrera refresh ↔ revocación: 20 pares concurrentes sin interbloqueos y sin sesiones vivas al final', async () => {
      for (let i = 0; i < 20; i++) {
        const issued = await open();
        const [refreshResult, revokeResult] = await Promise.allSettled([
          sessions.refresh(issued.refreshToken, HOST_A),
          inTenant(A, () => sessions.revokeTenantSession(issued.sessionId, 'ADMIN_REVOKED')),
        ]);
        expect(revokeResult).toEqual({ status: 'fulfilled', value: true });
        if (refreshResult.status === 'rejected') {
          expect(refreshResult.reason).toMatchObject({ code: 'UNAUTHENTICATED' });
        } else {
          // Si el refresh confirmó antes, su sucesor también queda revocado.
          await expect(sessions.refresh(refreshResult.value.refreshToken, HOST_A)).rejects.toMatchObject({
            code: 'UNAUTHENTICATED',
          });
        }
        await expect(sessions.checkSession(issued.sessionId)).resolves.toEqual({ active: false });
      }
    });

    it('carrera apertura ↔ "cerrar sesión": nunca queda una sesión de empresa viva de una identidad revocada', async () => {
      const identities: string[] = [];
      for (let i = 0; i < 20; i++) {
        const identity = await login();
        identities.push(identity);
        await Promise.allSettled([
          open(HOST_A, identity),
          sessions.revokeIdentitySession(identity, 'LOGOUT'),
        ]);
      }
      const { rows } = await owner.query(
        `SELECT count(*)::int AS n FROM tenant_sessions
          WHERE identity_session_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [identities],
      );
      expect(rows[0].n).toBe(0);
    });

    it('"cerrar sesión" revoca la sesión de identidad y todas sus sesiones de empresa (A y B)', async () => {
      const identity = await login();
      const a = await open(HOST_A, identity);
      const b = await open(HOST_B, identity);
      const elsewhere = await open(HOST_A);
      await sessions.revokeIdentitySession(identity, 'LOGOUT');
      await expect(sessions.checkSession(a.sessionId)).resolves.toEqual({ active: false });
      await expect(sessions.checkSession(b.sessionId)).resolves.toEqual({ active: false });
      await expect(sessions.checkSession(elsewhere.sessionId)).resolves.toMatchObject({ active: true });
      await expect(open(HOST_A, identity)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('"cerrar en todos los dispositivos" puede conservar la sesión actual y no toca a otros usuarios', async () => {
      const current = await login();
      const keep = await open(HOST_A, current);
      const other = await open(HOST_B);
      const otherUserSession = await open(HOST_A, await login(otherUser));
      await sessions.revokeAllForUser(user, 'PASSWORD_CHANGED', { exceptIdentitySessionId: current });
      await expect(sessions.checkSession(keep.sessionId)).resolves.toMatchObject({ active: true });
      await expect(sessions.checkSession(other.sessionId)).resolves.toEqual({ active: false });
      await expect(sessions.checkSession(otherUserSession.sessionId)).resolves.toMatchObject({
        active: true,
      });
      expect(await sessionRow(other.sessionId)).toMatchObject({ revoke_reason: 'PASSWORD_CHANGED' });
    });
  });

  describe('el tenant sale del contexto del request, nunca del llamador', () => {
    it('las operaciones de empresa sin contexto de tenant se rechazan', async () => {
      const issued = await open();
      await expect(sessions.revokeTenantSession(issued.sessionId, 'ADMIN_REVOKED')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        sessions.revokeMembershipSessions(membershipA, 'MEMBERSHIP_REVOKED'),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('desde el contexto de B no se puede revocar, verificar ni renovar una sesión de A', async () => {
      const a = await open(HOST_A);
      await expect(
        inTenant(B, () => sessions.revokeTenantSession(a.sessionId, 'ADMIN_REVOKED')),
      ).resolves.toBe(false);
      await expect(
        inTenant(B, () => sessions.revokeMembershipSessions(membershipA, 'MEMBERSHIP_REVOKED')),
      ).resolves.toBe(0);
      await expect(inTenant(B, () => sessions.checkSession(a.sessionId))).resolves.toEqual({ active: false });
      await expect(inTenant(B, () => sessions.refresh(a.refreshToken, HOST_A))).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      // Nada de lo anterior afectó a la sesión de A.
      await expect(inTenant(A, () => sessions.checkSession(a.sessionId))).resolves.toMatchObject({
        active: true,
      });
    });

    it('la empresa A revoca la membresía: fuera de A de inmediato; la sesión en B no se ve afectada', async () => {
      const identity = await login();
      const a = await open(HOST_A, identity);
      const b = await open(HOST_B, identity);
      await expect(
        inTenant(A, () => sessions.revokeMembershipSessions(membershipA, 'MEMBERSHIP_REVOKED')),
      ).resolves.toBeGreaterThan(0);
      await expect(sessions.checkSession(a.sessionId)).resolves.toEqual({ active: false });
      await expect(sessions.checkSession(b.sessionId)).resolves.toMatchObject({ active: true, tenantId: B });
      await expect(sessions.refresh(a.refreshToken, HOST_A)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    });
  });

  describe('independencia de Redis y ausencia de secretos en logs', () => {
    it('con Redis caído, apertura, rotación, gracia, verificación y revocación funcionan igual', async () => {
      const failing = (): Promise<never> => Promise.reject(new Error('Redis caído'));
      const spies = (['get', 'set', 'del', 'keys'] as const).map((m) =>
        jest.spyOn(redis.client, m).mockImplementation(failing as never),
      );
      try {
        const first = await open();
        const second = await sessions.refresh(first.refreshToken, HOST_A);
        const again = await sessions.refresh(first.refreshToken, HOST_A);
        expect(again.refreshToken).toBe(second.refreshToken);
        await expect(sessions.checkSession(first.sessionId)).resolves.toMatchObject({ active: true });
        await expect(
          inTenant(A, () => sessions.revokeTenantSession(first.sessionId, 'ADMIN_REVOKED')),
        ).resolves.toBe(true);
        await expect(sessions.checkSession(first.sessionId)).resolves.toEqual({ active: false });
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });

    it('ningún refresh ni access token aparece en los logs, ni siquiera al detectar una reutilización', async () => {
      const methods = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
      const spies = methods.map((m) => jest.spyOn(Logger.prototype, m));
      try {
        const first = await open();
        const second = await sessions.refresh(first.refreshToken, HOST_A);
        clock.advance(GRACE_MS + 1000);
        await expect(sessions.refresh(first.refreshToken, HOST_A)).rejects.toBeDefined();
        const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
        expect(logged).toContain('auth.refresh_token_reuse');
        for (const secret of [
          first.refreshToken,
          second.refreshToken,
          first.accessToken,
          second.accessToken,
        ]) {
          expect(logged).not.toContain(secret);
        }
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });
  });
});
