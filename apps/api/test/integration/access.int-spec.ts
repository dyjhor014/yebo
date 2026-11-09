/**
 * Fase 3.3 · Autorización y estado del tenant: denegar por defecto, verificación de sesión en cada ruta protegida,
 * permisos, gestión de accesos y matriz de estados (multitenancy §5 y §7.1–7.3; ADR-023; phase-3-plan, requisito
 * de la 3.3). PostgreSQL y Redis reales.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/http/configure-app';
import { parseEnv } from '../../src/config/env';
import type { RequestContextStore } from '../../src/infrastructure/context/request-context';
import { PERMISSION_CATALOG, ROLE_TEMPLATES } from '../../src/modules/access/permission-catalog';
import { PUBLIC_ROUTES } from '../../src/modules/access/public-routes';
import { RolesService } from '../../src/modules/access/roles.service';
import { routePolicyOf, type RoutePolicy } from '../../src/modules/access/route-policy';
import { SessionService } from '../../src/modules/identity/session.service';
import { TenantResolverService } from '../../src/modules/tenancy/tenant-resolver.service';
import { testBypassPool, testPool, RESET_TENANT_DATA } from '../support/db';

const DB = 'yebo_test';
const A = '0190f0a0-0000-7000-8000-00000000a033';
const B = '0190f0a0-0000-7000-8000-00000000b033';
const HOST_A = 'acceso-a.yebo.test';
const HOST_B = 'acceso-b.yebo.test';
const CSRF = 'csrf-de-prueba-0123456789abcdef';
const MIGRATION = resolve(__dirname, '../../prisma/migrations/20261110120000_fase3_3_access/migration.sql');
/** Permisos que añaden migraciones posteriores (4.3b: members.invite): se toma su bloque de siembra tal cual. */
const LATER_SEEDS = [
  resolve(__dirname, '../../prisma/migrations/20261110210000_fase4_3b_membership_invitations/migration.sql'),
  resolve(__dirname, '../../prisma/migrations/20261111020000_fase4_5_billing/migration.sql'),
].map((file) => {
  const sql = readFileSync(file, 'utf8');
  return sql.slice(sql.indexOf('INSERT INTO "permissions"'), sql.indexOf('-- Roles ya creados'));
});

interface Route {
  method: string;
  path: string;
  policy: RoutePolicy;
}

describe('Fase 3.3 · autorización y estado del tenant', () => {
  let app: INestApplication;
  let owner: Pool;
  let seed: Pool;
  let sessions: SessionService;
  let cls: ClsService<RequestContextStore>;
  let routes: Route[];
  const users: Record<'ana' | 'beto' | 'carla' | 'dani', string> = { ana: '', beto: '', carla: '', dani: '' };
  /** Membresías por tenant: m.A.ana, m.B.carla... */
  const m: Record<'A' | 'B', Record<string, string>> = { A: {}, B: {} };
  const role: Record<string, string> = {};

  const http = () => request(app.getHttpServer());

  function call(
    method: string,
    path: string,
    opts: { host?: string; token?: string; csrf?: boolean; body?: object } = {},
  ): request.Test {
    const verb = method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';
    const agent = http();
    let req = agent[verb](path).set('Host', opts.host ?? HOST_A);
    const csrf = opts.csrf ?? true;
    const cookies = [opts.token ? `__Host-yebo_at=${opts.token}` : '', csrf ? `__Host-yebo_csrf=${CSRF}` : '']
      .filter(Boolean)
      .join('; ');
    if (cookies) req = req.set('Cookie', cookies);
    if (csrf) req = req.set('X-CSRF-Token', CSRF);
    return opts.body ? req.send(opts.body) : req;
  }

  /** Abre una sesión real (identidad + empresa) y devuelve el access token y el id de la sesión de identidad. */
  async function signIn(user: string, host = HOST_A): Promise<{ token: string; identity: string }> {
    const identity = (await sessions.createIdentitySession({ userId: user, authMethods: ['pwd'] })).id;
    const issued = await sessions.openTenantSession({ identitySessionId: identity, host });
    return { token: issued.accessToken, identity };
  }

  async function setTenantStatus(tenant: string, host: string, status: string, cancelledDaysAgo?: number) {
    await owner.query(
      `UPDATE tenants SET status = $2::tenant_status,
              cancelled_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END
        WHERE id = $1`,
      [tenant, status, cancelledDaysAgo ?? null],
    );
    await app.get(TenantResolverService).invalidate(host);
  }

  function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return cls.run(async () => {
      cls.set('tenantId', tenantId);
      return fn();
    });
  }

  beforeAll(async () => {
    owner = testPool('owner', DB, 2);
    seed = testBypassPool(DB, 2);
    await owner.query(RESET_TENANT_DATA);
    // Otras suites vacían el catálogo: se vuelve a aplicar la migración (idempotente) para probar su contenido.
    await owner.query(readFileSync(MIGRATION, 'utf8'));
    for (const seed of LATER_SEEDS) await owner.query(seed);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(nest, parseEnv(process.env), { swagger: false });
    await nest.init();
    // Un solo servidor escuchando: si no, supertest abre uno por petición (fuga de listeners con carga).
    await nest.listen(0, '127.0.0.1');
    app = nest;
    sessions = app.get(SessionService);
    cls = app.get(ClsService);
    for (const host of [HOST_A, HOST_B]) await app.get(TenantResolverService).invalidate(host);

    await owner.query(
      `INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id_type, tax_id, status, updated_at) VALUES
         ($1, 'acceso-a', 'Transportes A S.A.C.', 'Transportes A', 'RUC', '20000000031', 'ACTIVE', now()),
         ($2, 'acceso-b', 'Naviera B S.A.C.', 'Naviera B', 'RUC', '20000000032', 'ACTIVE', now())`,
      [A, B],
    );
    await owner.query(
      `INSERT INTO tenant_domains (id, tenant_id, host, kind, is_primary, verification_status, verified_at, updated_at) VALUES
         (gen_random_uuid(), $1, $3, 'SUBDOMAIN', true, 'VERIFIED', now(), now()),
         (gen_random_uuid(), $2, $4, 'SUBDOMAIN', true, 'VERIFIED', now(), now())`,
      [A, B, HOST_A, HOST_B],
    );
    const created = await owner.query<{ id: string; email: string }>(
      `INSERT INTO users (id, email, password_hash, full_name, status, updated_at) VALUES
         (gen_random_uuid(), 'ana@example.com', 'x', 'Ana', 'ACTIVE', now()),
         (gen_random_uuid(), 'beto@example.com', 'x', 'Beto', 'ACTIVE', now()),
         (gen_random_uuid(), 'carla@example.com', 'x', 'Carla', 'ACTIVE', now()),
         (gen_random_uuid(), 'dani@example.com', 'x', 'Dani', 'ACTIVE', now()) RETURNING id, email`,
    );
    for (const row of created.rows) users[row.email.split('@')[0] as keyof typeof users] = row.id;

    // tenant_memberships y la configuración de roles tienen RLS forzado: se siembran con el rol de pruebas (ADR-034).
    const memberships: [keyof typeof m, string, string][] = [
      ['A', A, 'ana'],
      ['A', A, 'beto'],
      ['A', A, 'carla'],
      ['A', A, 'dani'],
      ['B', B, 'carla'],
      ['B', B, 'beto'],
    ];
    for (const [key, tenant, user] of memberships) {
      const r = await seed.query<{ id: string }>(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now()) RETURNING id`,
        [tenant, users[user as keyof typeof users]],
      );
      m[key][user] = r.rows[0]?.id ?? '';
    }

    // Plantilla Administrador en ambas empresas, creada por el servicio real (yebo_app con RLS).
    const roles = app.get(RolesService);
    role.adminA = (await inTenant(A, () => roles.instantiateTemplates()))[0] ?? '';
    role.adminB = (await inTenant(B, () => roles.instantiateTemplates()))[0] ?? '';
    // Roles parciales en A para probar la escalada de privilegios.
    const permissionId = async (code: string) =>
      (await owner.query<{ id: string }>('SELECT id FROM permissions WHERE code = $1', [code])).rows[0]?.id;
    async function createRole(name: string, codes: string[]): Promise<string> {
      const r = await seed.query<{ id: string }>(
        `INSERT INTO roles (id, tenant_id, name, is_system, updated_at) VALUES (gen_random_uuid(), $1, $2, false, now())
         RETURNING id`,
        [A, name],
      );
      const id = r.rows[0]?.id ?? '';
      for (const code of codes) {
        await seed.query(
          'INSERT INTO role_permissions (tenant_id, role_id, permission_id) VALUES ($1, $2, $3)',
          [A, id, await permissionId(code)],
        );
      }
      return id;
    }
    role.asignador = await createRole('Asignador', ['members.read', 'roles.assign']);
    role.minimo = await createRole('Mínimo', ['members.read']);
    role.lector = await createRole('Lector', ['members.read', 'roles.read']);
    const grant = (tenant: string, membership: string | undefined, roleId: string | undefined) =>
      seed.query('INSERT INTO membership_roles (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)', [
        tenant,
        membership,
        roleId,
      ]);
    await grant(A, m.A.ana, role.adminA);
    await grant(A, m.A.dani, role.asignador);
    await grant(B, m.B.carla, role.adminB);

    routes = discoverRoutes(app);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), seed.end()]);
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('denegar por defecto: barrido de rutas', () => {
    it('el inventario de rutas de Nest coincide con las rutas registradas en Express (ninguna se escapa)', () => {
      const express = (app as NestExpressApplication).getHttpAdapter().getInstance() as {
        router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
      };
      const registered = express.router.stack
        // Express 5 registra el middleware global (CLS, id de petición) como rutas `all()` sobre el prefijo y un
        // comodín: no son manejadores. Cualquier otra ruta debe salir de un controlador de Nest.
        .filter((layer) => layer.route && !['/api', '/api/{*path}'].includes(layer.route.path))
        .flatMap((layer) =>
          Object.keys(layer.route?.methods ?? {}).map((verb) => `${verb.toUpperCase()} ${layer.route?.path}`),
        )
        .sort();
      expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(registered);
    });

    it('toda ruta declara una política completa; las públicas son EXACTAMENTE las de PUBLIC_ROUTES', () => {
      const publicRoutes = routes
        .filter((r) => r.policy.kind === 'public')
        .map((r) => `${r.method} ${r.path}`);
      expect(publicRoutes.sort()).toEqual([...PUBLIC_ROUTES].sort());
      expect(routes.filter((r) => r.policy.kind === 'protected').length).toBeGreaterThanOrEqual(7);
    });

    it('sin token, TODA ruta protegida responde 401 en el host de una empresa', async () => {
      for (const route of protectedRoutes()) {
        const res = await call(route.method, concrete(route.path), { body: bodyFor(route) });
        expect({ route: `${route.method} ${route.path}`, status: res.status }).toEqual({
          route: `${route.method} ${route.path}`,
          status: 401,
        });
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('verificación de sesión en CADA ruta protegida (requisito de la 3.3)', () => {
    it('sesión revocada → 401', async () => {
      const { token, identity } = await signIn(users.ana);
      await sessions.revokeIdentitySession(identity, 'LOGOUT');
      for (const route of protectedRoutes()) {
        const res = await call(route.method, concrete(route.path), { token, body: bodyFor(route) });
        expect([`${route.method} ${route.path}`, res.status]).toEqual([`${route.method} ${route.path}`, 401]);
      }
    });

    it('token de la empresa B presentado en el host de A → 401 (§7.2)', async () => {
      const { token } = await signIn(users.carla, HOST_B);
      for (const route of protectedRoutes()) {
        const res = await call(route.method, concrete(route.path), { token, body: bodyFor(route) });
        expect([`${route.method} ${route.path}`, res.status]).toEqual([`${route.method} ${route.path}`, 401]);
      }
    });

    it('token con una versión de permisos anterior → 401 PERMISSIONS_CHANGED', async () => {
      const { token } = await signIn(users.ana);
      await seed.query(
        'UPDATE tenant_memberships SET permissions_version = permissions_version + 1 WHERE id = $1',
        [m.A.ana],
      );
      for (const route of protectedRoutes()) {
        const res = await call(route.method, concrete(route.path), { token, body: bodyFor(route) });
        expect([`${route.method} ${route.path}`, res.body.error?.code]).toEqual([
          `${route.method} ${route.path}`,
          'PERMISSIONS_CHANGED',
        ]);
      }
    });

    it('host desconocido → 404 en toda ruta protegida, aun con un token válido', async () => {
      const { token } = await signIn(users.ana);
      for (const route of protectedRoutes()) {
        const res = await call(route.method, concrete(route.path), {
          token,
          host: 'nadie.yebo.test',
          body: bodyFor(route),
        });
        expect(res.status).toBe(404);
      }
    });

    it('una mutación sin token CSRF → 403, aunque la sesión sea válida', async () => {
      const { token } = await signIn(users.ana);
      const res = await call('POST', `/api/v1/members/${m.A.beto}/sessions/revoke`, { token, csrf: false });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('permisos y aislamiento entre empresas', () => {
    it('sin el permiso → 403; con él → 200', async () => {
      const beto = await signIn(users.beto);
      expect((await call('GET', '/api/v1/members', { token: beto.token })).status).toBe(403);
      expect((await call('GET', '/api/v1/roles', { token: beto.token })).status).toBe(403);
      const ana = await signIn(users.ana);
      expect((await call('GET', '/api/v1/members', { token: ana.token })).status).toBe(200);
      expect((await call('GET', '/api/v1/roles', { token: ana.token })).status).toBe(200);
    });

    it('GET /auth/session (solo sesión) devuelve los permisos efectivos de esta empresa', async () => {
      const beto = await signIn(users.beto);
      const none = await call('GET', '/api/v1/auth/session', { token: beto.token });
      expect(none.status).toBe(200);
      expect(none.body.permissions).toEqual([]);
      const ana = await signIn(users.ana);
      const all = await call('GET', '/api/v1/auth/session', { token: ana.token });
      expect(all.body.permissions).toEqual([...ROLE_TEMPLATES.ADMIN.permissions].sort());
      expect(all.body.tenantId).toBe(A);
    });

    it('§7.1: el administrador de A con ids de B recibe 404, nunca 403', async () => {
      const ana = await signIn(users.ana);
      for (const [method, path, body] of [
        ['POST', `/api/v1/members/${m.B.carla}/suspend`, undefined],
        ['POST', `/api/v1/members/${m.B.beto}/reactivate`, undefined],
        ['POST', `/api/v1/members/${m.B.carla}/sessions/revoke`, undefined],
        ['PUT', `/api/v1/members/${m.B.beto}/roles`, { roleIds: [] }],
        ['PUT', `/api/v1/members/${m.A.beto}/roles`, { roleIds: [role.adminB] }],
      ] as const) {
        const res = await call(method, path, { token: ana.token, body });
        expect([path, res.status]).toEqual([path, 404]);
      }
      // Nada cambió en B.
      const b = await seed.query('SELECT status FROM tenant_memberships WHERE tenant_id = $1', [B]);
      expect(b.rows.every((r) => r.status === 'ACTIVE')).toBe(true);
    });

    it('§7.3: con sesión en A, una persona que también está en B solo ve A', async () => {
      const carlaA = await signIn(users.carla, HOST_A);
      expect((await call('GET', '/api/v1/members', { token: carlaA.token })).status).toBe(403);
      const carlaB = await signIn(users.carla, HOST_B);
      const list = await call('GET', '/api/v1/members', { token: carlaB.token, host: HOST_B });
      expect(list.status).toBe(200);
      expect(list.body.members.map((x: { membershipId: string }) => x.membershipId).sort()).toEqual(
        [m.B.carla, m.B.beto].sort(),
      );
      expect(list.body.members.map((x: { email: string }) => x.email).sort()).toEqual([
        'beto@example.com',
        'carla@example.com',
      ]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('gestión de accesos', () => {
    it('suspender corta el acceso de inmediato y cierra sus sesiones; reactivar no las revive', async () => {
      const ana = await signIn(users.ana);
      const beto = await signIn(users.beto);
      expect((await call('GET', '/api/v1/auth/session', { token: beto.token })).status).toBe(200);

      const suspended = await call('POST', `/api/v1/members/${m.A.beto}/suspend`, { token: ana.token });
      expect(suspended.status).toBe(200);
      expect(suspended.body).toMatchObject({ membershipId: m.A.beto, status: 'SUSPENDED' });
      expect(suspended.body.revokedSessions).toBeGreaterThanOrEqual(1);
      expect((await call('GET', '/api/v1/auth/session', { token: beto.token })).status).toBe(401);
      // Cerradas de verdad (no solo bloqueadas por el estado), con el motivo de la suspensión.
      const live = await owner.query(
        `SELECT 1 FROM tenant_sessions WHERE membership_id = $1 AND (revoked_at IS NULL OR revoke_reason <> 'MEMBERSHIP_REVOKED')`,
        [m.A.beto],
      );
      expect(live.rowCount).toBe(0);
      // Historial de medición (Fase 4.4): la suspensión queda con su autor, la membresía de Ana.
      const history = await seed.query(
        `SELECT status::text, changed_by_kind::text AS kind, changed_by_id AS id, reason
           FROM membership_status_history WHERE membership_id = $1 AND valid_to IS NULL`,
        [m.A.beto],
      );
      expect(history.rows).toEqual([
        { status: 'SUSPENDED', kind: 'MEMBERSHIP', id: m.A.ana, reason: 'members.suspend' },
      ]);
      // Suspender dos veces es un conflicto, no un éxito silencioso.
      expect((await call('POST', `/api/v1/members/${m.A.beto}/suspend`, { token: ana.token })).status).toBe(
        409,
      );
      // La empresa B no se ve afectada (identity-and-sessions §8).
      const betoB = await signIn(users.beto, HOST_B);
      expect((await call('GET', '/api/v1/auth/session', { token: betoB.token, host: HOST_B })).status).toBe(
        200,
      );

      const reactivated = await call('POST', `/api/v1/members/${m.A.beto}/reactivate`, { token: ana.token });
      expect(reactivated.status).toBe(200);
      expect(reactivated.body.status).toBe('ACTIVE');
      expect((await call('GET', '/api/v1/auth/session', { token: beto.token })).status).toBe(401);
      const again = await signIn(users.beto);
      expect((await call('GET', '/api/v1/auth/session', { token: again.token })).status).toBe(200);
    });

    it('reactivar cierra cualquier sesión que hubiera quedado abierta de antes de la suspensión', async () => {
      const ana = await signIn(users.ana);
      const leftover = await signIn(users.dani);
      // Suspensión sin cierre de sesiones (p. ej., si el cierre falló tras confirmar el cambio de estado).
      await seed.query("UPDATE tenant_memberships SET status = 'SUSPENDED' WHERE id = $1", [m.A.dani]);
      expect((await call('GET', '/api/v1/auth/session', { token: leftover.token })).status).toBe(401);
      const res = await call('POST', `/api/v1/members/${m.A.dani}/reactivate`, { token: ana.token });
      expect(res.status).toBe(200);
      expect(res.body.revokedSessions).toBeGreaterThanOrEqual(1);
      expect((await call('GET', '/api/v1/auth/session', { token: leftover.token })).status).toBe(401);
    });

    it('reactivar a alguien que no está suspendido responde 409 y NO cierra sus sesiones', async () => {
      const ana = await signIn(users.ana);
      const dani = await signIn(users.dani);
      const res = await call('POST', `/api/v1/members/${m.A.dani}/reactivate`, { token: ana.token });
      expect(res.status).toBe(409);
      expect((await call('GET', '/api/v1/auth/session', { token: dani.token })).status).toBe(200);
    });

    it('cerrar las sesiones de un miembro solo afecta a ESTA empresa', async () => {
      const ana = await signIn(users.ana);
      const betoA = await signIn(users.beto);
      const betoB = await signIn(users.beto, HOST_B);
      const res = await call('POST', `/api/v1/members/${m.A.beto}/sessions/revoke`, { token: ana.token });
      expect(res.status).toBe(200);
      expect(res.body.revokedSessions).toBeGreaterThanOrEqual(1);
      expect((await call('GET', '/api/v1/auth/session', { token: betoA.token })).status).toBe(401);
      expect((await call('GET', '/api/v1/auth/session', { token: betoB.token, host: HOST_B })).status).toBe(
        200,
      );
    });

    it('nadie puede suspenderse ni cambiar sus propios roles', async () => {
      const ana = await signIn(users.ana);
      expect((await call('POST', `/api/v1/members/${m.A.ana}/suspend`, { token: ana.token })).status).toBe(
        403,
      );
      const res = await call('PUT', `/api/v1/members/${m.A.ana}/roles`, {
        token: ana.token,
        body: { roleIds: [] },
      });
      expect(res.status).toBe(403);
    });

    it('anti-escalada: no se asignan ni retiran roles con permisos que quien asigna no tiene', async () => {
      const dani = await signIn(users.dani); // Asignador: members.read + roles.assign
      const put = (target: string | undefined, roleIds: (string | undefined)[]) =>
        call('PUT', `/api/v1/members/${target}/roles`, { token: dani.token, body: { roleIds } });
      expect((await put(m.A.beto, [role.adminA])).status).toBe(403);
      expect((await put(m.A.beto, [role.lector])).status).toBe(403); // roles.read no es suyo
      expect((await put(m.A.ana, [])).status).toBe(403); // retirar Administrador a Ana tampoco
      const ok = await put(m.A.beto, [role.minimo]);
      expect(ok.status).toBe(200);
      expect(ok.body.roleIds).toEqual([role.minimo]);
    });

    it('cambiar roles versiona los permisos: el token anterior pide renovar y la renovación trae los nuevos', async () => {
      const ana = await signIn(users.ana);
      const beto = await signIn(users.beto);
      const before = await call('GET', '/api/v1/members', { token: beto.token });
      const res = await call('PUT', `/api/v1/members/${m.A.beto}/roles`, {
        token: ana.token,
        body: { roleIds: [role.lector] },
      });
      expect(res.status).toBe(200);
      const stale = await call('GET', '/api/v1/members', { token: beto.token });
      expect(stale.status).toBe(401);
      expect(stale.body.error.code).toBe('PERMISSIONS_CHANGED');
      const fresh = await signIn(users.beto);
      expect((await call('GET', '/api/v1/roles', { token: fresh.token })).status).toBe(200);
      expect(before.status === 200 || before.status === 403).toBe(true);
    });

    it('asignaciones simultáneas se serializan: ni roles mezclados ni versiones perdidas (10 rondas)', async () => {
      const ana = await signIn(users.ana);
      const state = async () =>
        (
          await seed.query<{ v: number; roles: number }>(
            `SELECT m.permissions_version AS v,
                    (SELECT count(*)::int FROM membership_roles r WHERE r.membership_id = m.id) AS roles
               FROM tenant_memberships m WHERE m.id = $1`,
            [m.A.carla],
          )
        ).rows[0] ?? { v: 0, roles: 0 };
      const assign = (roleIds: (string | undefined)[]) =>
        call('PUT', `/api/v1/members/${m.A.carla}/roles`, { token: ana.token, body: { roleIds } });
      for (let round = 0; round < 10; round++) {
        const before = await state();
        const results = await Promise.all([
          assign([role.minimo]),
          assign([role.lector]),
          assign([role.minimo, role.lector]),
        ]);
        expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
        const after = await state();
        expect(after.v).toBe(before.v + 3);
        // El resultado es exactamente UNA de las tres asignaciones, nunca una mezcla.
        expect([1, 2]).toContain(after.roles);
        const final = (
          await seed.query<{ role_id: string }>(
            'SELECT role_id FROM membership_roles WHERE membership_id = $1 ORDER BY role_id',
            [m.A.carla],
          )
        ).rows.map((r) => r.role_id);
        const valid = [[role.minimo], [role.lector], [role.minimo, role.lector].sort()].map((x) =>
          JSON.stringify(x),
        );
        expect(valid).toContain(JSON.stringify(final));
      }
    });

    it('ids malformados o roles inexistentes → 404; cuerpo inválido → 400', async () => {
      const ana = await signIn(users.ana);
      expect((await call('POST', '/api/v1/members/no-es-uuid/suspend', { token: ana.token })).status).toBe(
        404,
      );
      const unknownRole = await call('PUT', `/api/v1/members/${m.A.beto}/roles`, {
        token: ana.token,
        body: { roleIds: ['0190f0a0-0000-7000-8000-0000000000ff'] },
      });
      expect(unknownRole.status).toBe(404);
      const invalid = await call('PUT', `/api/v1/members/${m.A.beto}/roles`, {
        token: ana.token,
        body: { roleIds: [role.minimo, role.minimo] },
      });
      expect(invalid.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('matriz de estados del tenant contra endpoints reales (ADR-023)', () => {
    const cases: [
      string,
      number | undefined,
      Record<'READ' | 'USERS_REDUCE' | 'USERS_ADD' | 'CONFIGURE', number>,
    ][] = [
      ['PAST_DUE', undefined, { READ: 200, USERS_REDUCE: 200, USERS_ADD: 409, CONFIGURE: 200 }],
      ['SUSPENDED', undefined, { READ: 200, USERS_REDUCE: 200, USERS_ADD: 403, CONFIGURE: 403 }],
      ['EXPIRED', undefined, { READ: 200, USERS_REDUCE: 200, USERS_ADD: 403, CONFIGURE: 403 }],
      ['CANCELLED', 1, { READ: 200, USERS_REDUCE: 200, USERS_ADD: 403, CONFIGURE: 403 }],
      ['CANCELLED', 31, { READ: 403, USERS_REDUCE: 403, USERS_ADD: 403, CONFIGURE: 403 }],
    ];

    afterEach(async () => {
      await setTenantStatus(A, HOST_A, 'ACTIVE');
    });

    it.each(cases)('%s (cancelado hace %s días)', async (status, days, expected) => {
      const ana = await signIn(users.ana); // la sesión se abre antes: el estado del tenant no cierra sesiones
      await setTenantStatus(A, HOST_A, status, days);
      const results = {
        READ: (await call('GET', '/api/v1/members', { token: ana.token })).status,
        // Reactivar a alguien ACTIVE → 409 si el estado lo permite; 403 si el estado lo bloquea antes.
        USERS_ADD: (await call('POST', `/api/v1/members/${m.A.dani}/reactivate`, { token: ana.token }))
          .status,
        CONFIGURE: (
          await call('PUT', `/api/v1/members/${m.A.dani}/roles`, {
            token: ana.token,
            body: { roleIds: [role.asignador] },
          })
        ).status,
        USERS_REDUCE: (
          await call('POST', `/api/v1/members/${m.A.dani}/sessions/revoke`, { token: ana.token })
        ).status,
      };
      expect(results).toEqual(expected);
    });

    it('las denegaciones por estado usan TENANT_RESTRICTED con un mensaje que explica el motivo', async () => {
      const ana = await signIn(users.ana);
      await setTenantStatus(A, HOST_A, 'SUSPENDED');
      const res = await call('PUT', `/api/v1/members/${m.A.dani}/roles`, {
        token: ana.token,
        body: { roleIds: [role.asignador] },
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('TENANT_RESTRICTED');
      expect(res.body.error.message).toMatch(/suspendida/);
    });

    it('tras el periodo de cierre no se inicia sesión (fila «Login»); durante el cierre, sí', async () => {
      await setTenantStatus(A, HOST_A, 'CANCELLED', 31);
      const closed = await http().get('/api/v1/auth/start').set('Host', HOST_A);
      expect(closed.status).toBe(403);
      expect(closed.body.error.code).toBe('TENANT_RESTRICTED');
      await setTenantStatus(A, HOST_A, 'CANCELLED', 1);
      expect((await http().get('/api/v1/auth/start').set('Host', HOST_A)).status).toBe(302);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('catálogo y plantillas', () => {
    it('la migración siembra exactamente el catálogo de permission-catalog.ts', async () => {
      const permissions = await owner.query<{
        code: string;
        module_code: string;
        is_sensitive: boolean;
        description: string;
      }>('SELECT code, module_code, is_sensitive, description FROM permissions ORDER BY code');
      expect(
        Object.fromEntries(
          permissions.rows.map((p) => [
            p.code,
            { module: p.module_code, sensitive: p.is_sensitive, description: p.description },
          ]),
        ),
      ).toEqual(PERMISSION_CATALOG);
      const templates = await owner.query<{ code: string; name: string; permission_codes: string[] }>(
        'SELECT code, name, permission_codes FROM role_templates ORDER BY code',
      );
      expect(templates.rows).toEqual(
        Object.entries(ROLE_TEMPLATES).map(([code, t]) => ({
          code,
          name: t.name,
          permission_codes: [...t.permissions],
        })),
      );
    });

    it('instanciar plantillas es idempotente y crea el rol de sistema con todos sus permisos', async () => {
      const roles = app.get(RolesService);
      expect(await inTenant(A, () => roles.instantiateTemplates())).toEqual([]);
      const listed = await inTenant(A, () => roles.list());
      const admin = listed.find((r) => r.name === 'Administrador');
      expect(admin).toMatchObject({
        isSystem: true,
        permissions: [...ROLE_TEMPLATES.ADMIN.permissions].sort(),
      });
    });

    it('yebo_app solo puede actualizar status, permissions_version y updated_at de tenant_memberships', async () => {
      const app = testPool('app', DB, 1);
      try {
        const client = await app.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
          await client.query("UPDATE tenant_memberships SET status = 'ACTIVE' WHERE id = $1", [m.A.dani]);
          for (const sql of [
            'UPDATE tenant_memberships SET billable = false WHERE id = $1',
            'UPDATE tenant_memberships SET user_id = user_id WHERE id = $1',
            'UPDATE tenant_memberships SET tenant_id = tenant_id WHERE id = $1',
          ]) {
            await client.query('SAVEPOINT s');
            await expect(client.query(sql, [m.A.dani])).rejects.toMatchObject({ code: '42501' });
            await client.query('ROLLBACK TO SAVEPOINT s');
          }
          // RLS: una membresía de B no es visible ni actualizable desde el contexto de A.
          const other = await client.query(
            "UPDATE tenant_memberships SET status = 'SUSPENDED' WHERE id = $1",
            [m.B.carla],
          );
          expect(other.rowCount).toBe(0);
          await expect(
            client.query(
              'INSERT INTO tenant_memberships (id, tenant_id, user_id) VALUES (gen_random_uuid(), $1, $2)',
              [A, users.beto],
            ),
          ).rejects.toMatchObject({ code: '42501' });
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      } finally {
        await app.end();
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  function protectedRoutes(): Route[] {
    return routes.filter((r) => r.policy.kind === 'protected');
  }
});

/** Sustituye los parámetros de ruta por un uuid cualquiera (las pruebas de autenticación no llegan al servicio). */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z]+/g, '0190f0a0-0000-7000-8000-0000000000aa');
}

function bodyFor(route: Route): object | undefined {
  return route.method === 'PUT' ? { roleIds: [] } : undefined;
}

/** Inventario de rutas a partir de los controladores registrados en Nest, con su política de acceso. */
function discoverRoutes(app: INestApplication): Route[] {
  const reflector = new Reflector();
  const found: Route[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!controller) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
      const proto = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (path === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
        const full = ['/api/v1', base, path]
          .map((p) => p.replace(/^\/+|\/+$/g, ''))
          .filter(Boolean)
          .join('/');
        found.push({
          method,
          path: `/${full}`,
          policy: routePolicyOf(reflector, [handler as () => void, controller], `${controller.name}.${name}`),
        });
      }
    }
  }
  return found;
}
