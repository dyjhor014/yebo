/**
 * Fase 3.4 · Coste de "una transacción por operación" (multitenancy §4.2) y de la cadena de guards de la 3.3.
 *
 * Escenarios con el cliente real (Prisma 7 + adaptador pg), en serie y con concurrencia:
 *  1. lectura con yebo_platform, sin RLS ni transacción (referencia);
 *  2. lectura con TenantDbService.client: BEGIN; set_config; consulta; COMMIT;
 *  3. "request típico" de 3 lecturas, una transacción por lectura;
 *  4. las mismas 3 lecturas agrupadas en UNA transacción (TenantDbService.transaction).
 * Además, peticiones HTTP reales (guards incluidos) y transacciones de PostgreSQL por petición.
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
import { PlatformPrismaService } from '../../src/infrastructure/database/platform-prisma.service';
import { TenantDbService } from '../../src/infrastructure/database/tenant-db.service';
import { RolesService } from '../../src/modules/access/roles.service';
import { SessionService } from '../../src/modules/identity/session.service';
import { TenantResolverService } from '../../src/modules/tenancy/tenant-resolver.service';
import { testPool } from '../support/db';

const DB = 'yebo_test';
const A = '0190f0a0-0000-7000-8000-00000000a0b1';
const HOST = 'bench-a.yebo.test';
const WARMUP = 200;
const SERIAL = 2000;
const WORKERS = 20;
const PER_WORKER = 150;
const HTTP_REQUESTS = 500;

interface Stats {
  name: string;
  n: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  opsPerSec?: number;
}

function stats(name: string, samples: number[], wallMs?: number): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    name,
    n: samples.length,
    meanMs: round(samples.reduce((a, b) => a + b, 0) / samples.length),
    p50Ms: round(at(0.5)),
    p95Ms: round(at(0.95)),
    p99Ms: round(at(0.99)),
    ...(wallMs ? { opsPerSec: Math.round((samples.length / wallMs) * 1000) } : {}),
  };
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function serial(name: string, fn: () => Promise<unknown>): Promise<Stats> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < SERIAL; i++) samples.push(await timed(fn));
  return stats(name, samples);
}

async function concurrent(name: string, fn: () => Promise<unknown>): Promise<Stats> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples: number[] = [];
  const start = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      for (let i = 0; i < PER_WORKER; i++) samples.push(await timed(fn));
    }),
  );
  return stats(name, samples, Number(process.hrtime.bigint() - start) / 1e6);
}

describe('Fase 3.4 · medición del coste de una transacción por operación', () => {
  let app: INestApplication;
  let owner: Pool;
  let platformPool: Pool;
  const results: Stats[] = [];

  afterAll(async () => {
    process.stdout.write(`\nRESULTADOS_BENCH ${JSON.stringify(results)}\n`);
    await app?.close();
    await Promise.all([owner?.end(), platformPool?.end()]);
  });

  it('mide', async () => {
    owner = testPool('owner', DB, 2);
    platformPool = testPool('platform', DB, 2);
    await owner.query(
      'TRUNCATE authorization_codes, refresh_tokens, tenant_sessions, identity_sessions, membership_roles, role_permissions, roles, tenant_memberships, users, permissions, role_templates, tenant_domains, tenants',
    );
    await owner.query(
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
    await app.get(TenantResolverService).invalidate(HOST);
    await owner.query(
      `INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id_type, tax_id, status, updated_at)
       VALUES ($1, 'bench-a', 'Bench A', 'Bench A', 'RUC', '20000000051', 'ACTIVE', now())`,
      [A],
    );
    await owner.query(
      `INSERT INTO tenant_domains (id, tenant_id, host, kind, is_primary, verification_status, verified_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'SUBDOMAIN', true, 'VERIFIED', now(), now())`,
      [A, HOST],
    );
    // 50 personas en la empresa; la primera es administradora.
    const users = await owner.query<{ id: string }>(
      `INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
       SELECT gen_random_uuid(), 'p' || g || '@example.com', 'x', 'Persona ' || g, 'ACTIVE', now()
         FROM generate_series(1, 50) g RETURNING id`,
    );
    const memberships: string[] = [];
    for (const u of users.rows) {
      const r = await platformPool.query<{ id: string }>(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now()) RETURNING id`,
        [A, u.id],
      );
      memberships.push(r.rows[0]?.id ?? '');
    }
    const cls = app.get<ClsService<RequestContextStore>>(ClsService);
    // `await` DENTRO del contexto: las consultas de Prisma son perezosas y se ejecutan al esperarlas.
    const inA = <T>(fn: () => PromiseLike<T>) =>
      cls.run(async () => {
        cls.set('tenantId', A);
        return await fn();
      });
    const admin = (await inA(() => app.get(RolesService).instantiateTemplates()))[0] ?? '';
    await platformPool.query(
      'INSERT INTO membership_roles (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)',
      [A, memberships[0], admin],
    );

    const tenantDb = app.get(TenantDbService);
    const platform = app.get(PlatformPrismaService).client;
    const member = memberships[0] ?? '';
    const reference = () =>
      platform.role.findFirst({ where: { tenantId: A, id: admin }, select: { id: true } });
    const perOperation = () =>
      inA(() => tenantDb.client.role.findFirst({ where: { id: admin }, select: { id: true } }));
    const threeReads = (db: Pick<typeof tenantDb.client, 'role' | 'membershipRole' | 'tenantMembership'>) =>
      Promise.all([
        db.role.findFirst({ where: { id: admin }, select: { id: true } }),
        db.membershipRole.findMany({ where: { membershipId: member }, select: { roleId: true } }),
        db.tenantMembership.findFirst({ where: { id: member }, select: { status: true } }),
      ]);
    const threeSeparate = () => inA(() => threeReads(tenantDb.client));
    const threeSequentialSeparate = () =>
      inA(async () => {
        await tenantDb.client.role.findFirst({ where: { id: admin }, select: { id: true } });
        await tenantDb.client.membershipRole.findMany({
          where: { membershipId: member },
          select: { roleId: true },
        });
        await tenantDb.client.tenantMembership.findFirst({ where: { id: member }, select: { status: true } });
      });
    const threeGrouped = () =>
      inA(() =>
        tenantDb.transaction(async (tx) => {
          await tx.role.findFirst({ where: { id: admin }, select: { id: true } });
          await tx.membershipRole.findMany({ where: { membershipId: member }, select: { roleId: true } });
          await tx.tenantMembership.findFirst({ where: { id: member }, select: { status: true } });
        }),
      );

    // 0 · coste de una ida y vuelta, para separar red/PostgreSQL de la sobrecarga del cliente.
    const rawPool = testPool('app', DB, WORKERS);
    const appPrisma = app.get(AppPrismaService).client;
    results.push(
      await serial('0a · SELECT 1 con el driver pg directo (una ida y vuelta)', () =>
        rawPool.query('SELECT 1'),
      ),
    );
    results.push(await serial('0b · SELECT 1 con Prisma ($queryRaw)', () => appPrisma.$queryRaw`SELECT 1`));
    results.push(
      await serial('0c · BEGIN; set_config; SELECT; COMMIT con el driver pg directo', async () => {
        const client = await rawPool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
          await client.query('SELECT id FROM roles WHERE id = $1', [admin]);
          await client.query('COMMIT');
        } finally {
          client.release();
        }
      }),
    );
    await rawPool.end();
    results.push(await serial('1 · referencia: yebo_platform, sin RLS ni transacción', reference));
    results.push(await serial('2 · yebo_app, una transacción por operación', perOperation));
    results.push(await serial('3a · 3 lecturas en serie, una transacción cada una', threeSequentialSeparate));
    results.push(await serial('3b · 3 lecturas en paralelo, una transacción cada una', threeSeparate));
    results.push(await serial('4 · 3 lecturas en UNA transacción', threeGrouped));
    results.push(await concurrent(`1 · referencia, ${WORKERS} concurrentes`, reference));
    results.push(
      await concurrent(`2 · una transacción por operación, ${WORKERS} concurrentes`, perOperation),
    );
    results.push(
      await concurrent(
        `3a · 3 lecturas, una transacción cada una, ${WORKERS} concurrentes`,
        threeSequentialSeparate,
      ),
    );
    results.push(
      await concurrent(`4 · 3 lecturas en una transacción, ${WORKERS} concurrentes`, threeGrouped),
    );

    // HTTP real, con la cadena de guards completa.
    const sessions = app.get(SessionService);
    const identity = (
      await sessions.createIdentitySession({ userId: users.rows[0]?.id ?? '', authMethods: ['pwd'] })
    ).id;
    const token = (await sessions.openTenantSession({ identitySessionId: identity, host: HOST })).accessToken;
    const server = app.getHttpServer();
    const hit = (path: string) => async () => {
      const res = await request(server).get(path).set('Host', HOST).set('Cookie', `__Host-yebo_at=${token}`);
      if (res.status !== 200) throw new Error(`${path} → ${res.status}`);
    };
    const commits = async () =>
      Number(
        (
          await owner.query<{ c: string }>(
            'SELECT xact_commit::text AS c FROM pg_stat_database WHERE datname = $1',
            [DB],
          )
        ).rows[0]?.c ?? 0,
      );
    for (const path of ['/api/v1/public/site', '/api/v1/auth/session', '/api/v1/members']) {
      for (let i = 0; i < 50; i++) await hit(path)();
      await owner.query('SELECT pg_stat_force_next_flush()');
      const before = await commits();
      const samples: number[] = [];
      for (let i = 0; i < HTTP_REQUESTS; i++) samples.push(await timed(hit(path)));
      await owner.query('SELECT pg_stat_force_next_flush()');
      await new Promise((r) => setTimeout(r, 1500));
      const after = await commits();
      const s = stats(`HTTP GET ${path} (en serie)`, samples);
      results.push({
        ...s,
        name: `${s.name} · ~${((after - before) / HTTP_REQUESTS).toFixed(1)} transacciones de PG por petición`,
      });
    }
    expect(results.length).toBeGreaterThan(0);
  });
});
