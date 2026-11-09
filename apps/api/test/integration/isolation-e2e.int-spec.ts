/**
 * Fase 3.4 · Aislamiento de extremo a extremo sobre endpoints REALES autenticados (multitenancy §7.3, §7.4 y §7.6).
 * Cientos de peticiones concurrentes de dos empresas, con la MISMA persona en ambas, comparten el pool de
 * conexiones, el contexto CLS, la caché del resolver y los guards. Ninguna respuesta puede contener datos de la
 * otra empresa, y al terminar ninguna conexión del pool conserva un tenant.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import type { RequestContextStore } from '../../src/infrastructure/context/request-context';
import { AppPrismaService } from '../../src/infrastructure/database/app-prisma.service';
import { RolesService } from '../../src/modules/access/roles.service';
import { SessionService } from '../../src/modules/identity/session.service';
import { TenantResolverService } from '../../src/modules/tenancy/tenant-resolver.service';
import { testBypassPool, testPool, RESET_TENANT_DATA } from '../support/db';

const DB = 'yebo_test';
const CSRF = 'csrf-e2e-0123456789abcdef0123';
const TENANTS = {
  A: { id: '0190f0a0-0000-7000-8000-00000000a034', host: 'e2e-a.yebo.test', people: ['ana', 'alba', 'abel'] },
  B: { id: '0190f0a0-0000-7000-8000-00000000b034', host: 'e2e-b.yebo.test', people: ['bruno', 'berta'] },
} as const;
type Key = keyof typeof TENANTS;
/** Persona con membresía y rol Administrador en AMBAS empresas: el caso más exigente de §7.3. */
const SHARED = 'compartida';

describe('Fase 3.4 · aislamiento de extremo a extremo y concurrencia (§7.3, §7.4, §7.6)', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let sessions: SessionService;
  const memberships: Record<Key, Set<string>> = { A: new Set(), B: new Set() };
  const membershipOf: Record<Key, Record<string, string>> = { A: {}, B: {} };
  const adminRole: Record<Key, string> = { A: '', B: '' };
  const tokens: Record<Key, string> = { A: '', B: '' };

  const http = () => request(app.getHttpServer());
  const get = (key: Key, path: string, token = tokens[key]) =>
    http().get(path).set('Host', TENANTS[key].host).set('Cookie', `__Host-yebo_at=${token}`);
  const put = (key: Key, path: string, body: object) =>
    http()
      .put(path)
      .set('Host', TENANTS[key].host)
      .set('Cookie', `__Host-yebo_at=${tokens[key]}; __Host-yebo_csrf=${CSRF}`)
      .set('X-CSRF-Token', CSRF)
      .send(body);

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    seed = testBypassPool(DB, 2);
    await owner.query(RESET_TENANT_DATA);
    await owner.query(
      // Catálogo de la 3.3 (otras suites vacían estas tablas).
      `INSERT INTO permissions (id, code, module_code, description, is_sensitive, updated_at)
         SELECT gen_random_uuid(), c, 'ACCESS', c, false, now()
           FROM unnest(ARRAY['members.read','members.suspend','members.reactivate','members.sessions.revoke','roles.read','roles.assign']) c;
       INSERT INTO role_templates (id, code, name, permission_codes, updated_at)
         VALUES (gen_random_uuid(), 'ADMIN', 'Administrador',
                 ARRAY['members.read','members.suspend','members.reactivate','members.sessions.revoke','roles.read','roles.assign'], now());`,
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(nest, parseEnv(process.env), { swagger: false });
    await nest.init();
    // Un solo servidor escuchando: si no, supertest abre uno por petición (fuga de listeners con carga).
    await nest.listen(0, '127.0.0.1');
    app = nest;
    sessions = app.get(SessionService);
    const cls = app.get<ClsService<RequestContextStore>>(ClsService);

    for (const key of ['A', 'B'] as const) {
      const t = TENANTS[key];
      await app.get(TenantResolverService).invalidate(t.host);
      await owner.query(
        `INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id_type, tax_id, status, updated_at)
         VALUES ($1, $2, $3, $3, 'RUC', $4, 'ACTIVE', now())`,
        [t.id, `e2e-${key.toLowerCase()}`, `Empresa ${key}`, key === 'A' ? '20000000041' : '20000000042'],
      );
      await owner.query(
        `INSERT INTO tenant_domains (id, tenant_id, host, kind, is_primary, verification_status, verified_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'SUBDOMAIN', true, 'VERIFIED', now(), now())`,
        [t.id, t.host],
      );
    }
    const people = [...TENANTS.A.people, ...TENANTS.B.people, SHARED];
    const users = new Map<string, string>();
    for (const name of people) {
      const r = await owner.query<{ id: string }>(
        `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
         VALUES (gen_random_uuid(), $1, 'x', $2, 'ACTIVE', now()) RETURNING id`,
        [`${name}@example.com`, name],
      );
      users.set(name, r.rows[0]?.id ?? '');
    }
    for (const key of ['A', 'B'] as const) {
      for (const name of [...TENANTS[key].people, SHARED]) {
        const r = await seed.query<{ id: string }>(
          `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now()) RETURNING id`,
          [TENANTS[key].id, users.get(name)],
        );
        const id = r.rows[0]?.id ?? '';
        memberships[key].add(id);
        membershipOf[key][name] = id;
      }
      adminRole[key] =
        (
          await cls.run(async () => {
            cls.set('tenantId', TENANTS[key].id);
            return app.get(RolesService).instantiateTemplates();
          })
        )[0] ?? '';
      await seed.query(
        'INSERT INTO membership_roles (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)',
        [TENANTS[key].id, membershipOf[key][SHARED], adminRole[key]],
      );
      // La MISMA persona, con una sesión por empresa (desde la misma sesión de identidad: un solo navegador).
    }
    const identity = (
      await sessions.createIdentitySession({ userId: users.get(SHARED) ?? '', authMethods: ['pwd'] })
    ).id;
    for (const key of ['A', 'B'] as const) {
      tokens[key] = (
        await sessions.openTenantSession({ identitySessionId: identity, host: TENANTS[key].host })
      ).accessToken;
    }
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  it('600 lecturas concurrentes y entrelazadas de A y B: cada respuesta contiene solo datos de su empresa', async () => {
    const plan = Array.from({ length: 600 }, (_, i) => ({
      key: (i % 2 === 0 ? 'A' : 'B') as Key,
      path: ['/api/v1/members', '/api/v1/roles', '/api/v1/auth/session'][i % 3] as string,
    }));
    const responses = await Promise.all(plan.map((p) => get(p.key, p.path)));
    let checked = 0;
    responses.forEach((res, i) => {
      const { key, path } = plan[i] as { key: Key; path: string };
      expect([key, path, res.status]).toEqual([key, path, 200]);
      if (path.endsWith('/members')) {
        const ids = new Set<string>(res.body.members.map((x: { membershipId: string }) => x.membershipId));
        expect(ids).toEqual(memberships[key]);
      } else if (path.endsWith('/roles')) {
        expect(res.body.roles.map((r: { id: string }) => r.id)).toEqual([adminRole[key]]);
      } else {
        expect(res.body.tenantId).toBe(TENANTS[key].id);
        expect(res.body.membershipId).toBe(membershipOf[key][SHARED]);
      }
      checked++;
    });
    expect(checked).toBe(600);
  });

  it('el token de una empresa nunca vale en la otra, aun en plena carga y siendo la misma persona (§7.2)', async () => {
    const crossed = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        i % 2 === 0 ? get('B', '/api/v1/members', tokens.A) : get('A', '/api/v1/members', tokens.B),
      ),
    );
    expect(new Set(crossed.map((r) => r.status))).toEqual(new Set([401]));
  });

  it('escrituras concurrentes en ambas empresas: cada asignación queda en su tenant y versiona solo su membresía', async () => {
    const targets = { A: membershipOf.A.alba ?? '', B: membershipOf.B.berta ?? '' };
    const version = async (id: string) =>
      (
        await seed.query<{ v: number }>(
          'SELECT permissions_version AS v FROM tenant_memberships WHERE id = $1',
          [id],
        )
      ).rows[0]?.v ?? 0;
    const before = { A: await version(targets.A), B: await version(targets.B) };
    const writes = Array.from({ length: 40 }, (_, i) => {
      const key: Key = i % 2 === 0 ? 'A' : 'B';
      return put(key, `/api/v1/members/${targets[key]}/roles`, {
        roleIds: i % 4 < 2 ? [adminRole[key]] : [],
      });
    });
    const results = await Promise.all(writes);
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([200]));
    expect(await version(targets.A)).toBe(before.A + 20);
    expect(await version(targets.B)).toBe(before.B + 20);
    // Ninguna fila mezcla tenants (además, las FK compuestas lo impiden).
    const mixed = await seed.query(
      `SELECT 1 FROM membership_roles mr
         JOIN tenant_memberships m ON m.id = mr.membership_id
         JOIN roles r ON r.id = mr.role_id
        WHERE mr.tenant_id <> m.tenant_id OR mr.tenant_id <> r.tenant_id`,
    );
    expect(mixed.rowCount).toBe(0);
  });

  it('§7.4 tras la carga: ninguna conexión reutilizada del pool de la API conserva un tenant (0 filas sin contexto)', async () => {
    // Mismo pool (yebo_app) que acaban de usar las peticiones, sin pasar por la extensión de tenant.
    const prisma = app.get(AppPrismaService).client;
    const results = await Promise.all(
      Array.from(
        { length: 40 },
        () =>
          prisma.$queryRaw<{ n: number; ctx: string | null }[]>`
          SELECT (SELECT count(*)::int FROM tenant_memberships) +
                 (SELECT count(*)::int FROM roles) +
                 (SELECT count(*)::int FROM membership_roles) AS n,
                 current_setting('app.tenant_id', true) AS ctx`,
      ),
    );
    for (const [row] of results) {
      expect(row?.n).toBe(0);
      expect([null, '']).toContain(row?.ctx ?? null);
    }
  });
});
