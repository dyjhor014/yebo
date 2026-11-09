/**
 * Fase 3.1 · Esquema de tenancy e identidad + resolución del tenant por host.
 * Criterios de multitenancy §7: 0 filas sin contexto (7.4), FK cruzada (7.5), concurrencia sin
 * mezcla de contexto (7.6) y cobertura de RLS (7.7), además de la matriz de privilegios de §4.3.
 * PostgreSQL y Redis reales, roles reales (yebo_app sin BYPASSRLS).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ClsService } from 'nestjs-cls';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { createPrismaClient } from '../../src/infrastructure/database/create-prisma-client';
import { TenantDbService } from '../../src/infrastructure/database/tenant-db.service';
import {
  GLOBAL_TABLES_WITH_TENANT_ID,
  TENANT_SCOPED_TABLES,
  TENANT_SCOPED_MODELS,
} from '../../src/infrastructure/database/tenant-scoped-models';
import { TenantResolverService } from '../../src/modules/tenancy/tenant-resolver.service';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createTestApp } from '../support/create-test-app';
import { testBypassUrl, testPool, RESET_TENANT_DATA } from '../support/db';

const DB = 'yebo_test';
const A = '0190f0a0-0000-7000-8000-00000000a001';
const B = '0190f0a0-0000-7000-8000-00000000b001';
const HOST_A = 'transportesa.yebo.test';
const HOST_B = 'navierab.yebo.test';
const HOST_PENDING = 'pendiente.yebo.test';

async function seed(platform: PrismaClient): Promise<{ roleA: string; roleB: string; membershipA: string }> {
  await platform.tenant.createMany({
    data: [
      {
        id: A,
        slug: 'transportesa',
        legalName: 'Transportes A S.A.C.',
        tradeName: 'Transportes A',
        taxIdType: 'RUC',
        taxId: '20000000001',
        status: 'ACTIVE',
      },
      {
        id: B,
        slug: 'navierab',
        legalName: 'Naviera B E.I.R.L.',
        tradeName: 'Naviera B',
        taxIdType: 'RUC',
        taxId: '20000000002',
        status: 'ACTIVE',
      },
    ],
  });
  await platform.tenantDomain.createMany({
    data: [
      {
        tenantId: A,
        host: HOST_A,
        kind: 'SUBDOMAIN',
        isPrimary: true,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
      {
        tenantId: B,
        host: HOST_B,
        kind: 'SUBDOMAIN',
        isPrimary: true,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
      { tenantId: A, host: HOST_PENDING, kind: 'CUSTOM', verificationStatus: 'PENDING' },
    ],
  });
  // Un mismo usuario con membresía en ambas empresas (D3).
  const user = await platform.user.create({
    data: { email: 'operador@example.com', passwordHash: '$argon2id$placeholder', fullName: 'Operador' },
  });
  const membershipA = await platform.tenantMembership.create({
    data: { tenantId: A, userId: user.id, status: 'ACTIVE' },
  });
  await platform.tenantMembership.create({ data: { tenantId: B, userId: user.id, status: 'ACTIVE' } });
  const perm = await platform.permission.create({
    data: {
      code: 'shipments.deliver',
      moduleCode: 'PARCELS',
      description: 'Entregar encomiendas',
      isSensitive: true,
    },
  });
  const roleA = await platform.role.create({ data: { tenantId: A, name: 'Almacenero' } });
  const roleB = await platform.role.create({ data: { tenantId: B, name: 'Almacenero' } });
  await platform.rolePermission.createMany({
    data: [
      { tenantId: A, roleId: roleA.id, permissionId: perm.id },
      { tenantId: B, roleId: roleB.id, permissionId: perm.id },
    ],
  });
  await platform.membershipRole.create({
    data: { tenantId: A, membershipId: membershipA.id, roleId: roleA.id },
  });
  return { roleA: roleA.id, roleB: roleB.id, membershipA: membershipA.id };
}

async function inTenant<T>(pool: Pool, tenant: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenant) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('Fase 3.1 · tenancy e identidad (PostgreSQL real, rol yebo_app)', () => {
  let app: NestExpressApplication;
  let platform: PrismaClient;
  let owner: Pool;
  let appPool: Pool;
  let ids: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    owner = testPool('owner', DB, 1);
    await owner.query(RESET_TENANT_DATA);
    appPool = testPool('app', DB, 4);
    app = await createTestApp();
    // Un solo servidor escuchando: si no, supertest abre uno por petición (fuga de listeners en §7.6).
    await app.listen(0, '127.0.0.1');
    // Siembra con el rol EXCLUSIVO de pruebas (ADR-034): yebo_platform ya no salta RLS ni escribe.
    platform = createPrismaClient({
      connectionString: testBypassUrl(DB),
      max: 2,
      applicationName: 'yebo-test-seed',
      txMaxWaitMs: 10_000,
    });
    await app.get(TenantResolverService).invalidate(HOST_A);
    await app.get(TenantResolverService).invalidate(HOST_B);
    await app.get(TenantResolverService).invalidate(HOST_PENDING);
    ids = await seed(platform);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), appPool.end(), platform.$disconnect()]);
  });

  describe('base de datos', () => {
    const tenantTables = [...TENANT_SCOPED_TABLES];

    it('§7.7 · toda tabla con tenant_id tiene RLS habilitado y forzado, salvo las excepciones globales declaradas', async () => {
      const { rows } = await owner.query<{ table: string; enabled: boolean; forced: boolean }>(`
        SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         WHERE c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
      const scoped = rows.filter((r) => !GLOBAL_TABLES_WITH_TENANT_ID.includes(r.table));
      expect(scoped.map((r) => r.table).sort()).toEqual([...tenantTables].sort());
      expect(scoped.filter((r) => !r.enabled || !r.forced)).toEqual([]);
      expect(TENANT_SCOPED_MODELS.size).toBe(tenantTables.length);
    });

    it('§7.4 · yebo_app sin app.tenant_id ve 0 filas en todas las tablas de tenant (y con contexto vacío)', async () => {
      for (const t of tenantTables) {
        for (const ctx of [null, '']) {
          const n = await inTenant(
            appPool,
            ctx,
            async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]?.n,
          );
          expect({ table: t, ctx, n }).toEqual({ table: t, ctx, n: 0 });
        }
      }
    });

    it('con contexto, cada tenant ve solo lo suyo', async () => {
      const rolesA = await inTenant(
        appPool,
        A,
        async (c) => (await c.query('SELECT tenant_id FROM roles')).rows,
      );
      expect(rolesA).toEqual([{ tenant_id: A }]);
      const membershipsB = await inTenant(
        appPool,
        B,
        async (c) => (await c.query('SELECT tenant_id FROM tenant_memberships')).rows,
      );
      expect(membershipsB).toEqual([{ tenant_id: B }]);
    });

    it('§4.3 · yebo_app no tiene acceso a tenants, tenant_domains ni users (ni siquiera lectura)', async () => {
      for (const t of ['tenants', 'tenant_domains', 'users']) {
        await expect(appPool.query(`SELECT 1 FROM ${t} LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('§4.3 · catálogos y membresías: yebo_app solo lee; roles: DML con RLS en su tenant', async () => {
      await expect(appPool.query(`SELECT count(*) FROM permissions`)).resolves.toBeDefined();
      await expect(
        appPool.query(
          `INSERT INTO permissions (id, code, module_code, description) VALUES (gen_random_uuid(), 'x.y', 'X', 'x')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        inTenant(appPool, A, (c) => c.query(`UPDATE tenant_memberships SET billable = false`)),
      ).rejects.toMatchObject({ code: '42501' });
      const created = await inTenant(
        appPool,
        A,
        async (c) =>
          (
            await c.query(
              `INSERT INTO roles (id, tenant_id, name, updated_at) VALUES (gen_random_uuid(), $1, 'Cajero', now()) RETURNING tenant_id`,
              [A],
            )
          ).rows,
      );
      expect(created).toEqual([{ tenant_id: A }]);
      await expect(
        inTenant(appPool, A, (c) =>
          c.query(
            `INSERT INTO roles (id, tenant_id, name, updated_at) VALUES (gen_random_uuid(), $1, 'Intruso', now())`,
            [B],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('§7.5 · la FK compuesta impide asignar a una membresía de A un rol de B, incluso con un rol que salta RLS', async () => {
      await expect(
        platform.membershipRole.create({
          data: { tenantId: A, membershipId: ids.membershipA, roleId: ids.roleB },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('un solo dominio principal por tenant; hosts y slugs normalizados', async () => {
      await expect(
        platform.tenantDomain.create({
          data: { tenantId: A, host: 'otro.yebo.test', kind: 'SUBDOMAIN', isPrimary: true },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        owner.query(`UPDATE tenant_domains SET is_primary = false WHERE host = $1`, [HOST_A]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        platform.tenantDomain.create({ data: { tenantId: A, host: 'Mayus.yebo.test', kind: 'CUSTOM' } }),
      ).rejects.toThrow(/tenant_domains_host_normalized/);
      await expect(
        platform.tenant.create({
          data: {
            slug: 'Con Espacios',
            legalName: 'x',
            tradeName: 'x',
            taxIdType: 'RUC',
            taxId: '20000000009',
          },
        }),
      ).rejects.toThrow(/tenants_slug_format/);
    });

    it('la extensión de producción (TenantDbService) filtra los modelos reales por el tenant del contexto', async () => {
      const cls = app.get(ClsService);
      const tenantDb = app.get(TenantDbService);
      const roles = await cls.run(async () => {
        cls.set('tenantId', B);
        return tenantDb.client.role.findMany();
      });
      expect(roles.map((r) => r.tenantId)).toEqual([B]);
      const crossRead = await cls.run(async () => {
        cls.set('tenantId', B);
        return tenantDb.client.role.findFirst({ where: { id: ids.roleA } });
      });
      expect(crossRead).toBeNull(); // IDOR → null → 404
    });
  });

  describe('resolución del tenant por host (ADR-004)', () => {
    it('GET /api/v1/public/site devuelve la empresa del host', async () => {
      const a = await request(app.getHttpServer()).get('/api/v1/public/site').set('Host', HOST_A).expect(200);
      expect(a.body).toEqual({ tenant: { slug: 'transportesa', tradeName: 'Transportes A' } });
      const b = await request(app.getHttpServer())
        .get('/api/v1/public/site')
        .set('Host', `${HOST_B}:8080`)
        .expect(200);
      expect(b.body.tenant.slug).toBe('navierab');
    });

    it('host desconocido o dominio no verificado → 404 con el formato de error único', async () => {
      for (const host of ['desconocido.yebo.test', HOST_PENDING, 'localhost', 'a..b']) {
        const res = await request(app.getHttpServer())
          .get('/api/v1/public/site')
          .set('Host', host)
          .expect(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    });

    it('X-Forwarded-Host solo se acepta del proxy de confianza (TRUST_PROXY)', async () => {
      // La prueba llega desde loopback, que es el proxy de confianza por defecto: se acepta.
      const trusted = await request(app.getHttpServer())
        .get('/api/v1/public/site')
        .set('Host', 'interno.local')
        .set('X-Forwarded-Host', HOST_B)
        .expect(200);
      expect(trusted.body.tenant.slug).toBe('navierab');

      // Sin proxy de confianza, la cabecera del cliente se ignora y manda el Host real.
      const untrustedApp = await createTestApp({ TRUST_PROXY: 'false' });
      try {
        const ignored = await request(untrustedApp.getHttpServer())
          .get('/api/v1/public/site')
          .set('Host', HOST_A)
          .set('X-Forwarded-Host', HOST_B)
          .expect(200);
        expect(ignored.body.tenant.slug).toBe('transportesa');
      } finally {
        await untrustedApp.close();
      }
    });

    it('la caché refleja un cambio de dominio tras invalidarlo', async () => {
      const resolver = app.get(TenantResolverService);
      await expect(resolver.resolve(HOST_A)).resolves.toMatchObject({ id: A });
      await platform.tenantDomain.update({ where: { host: HOST_A }, data: { verificationStatus: 'FAILED' } });
      await expect(resolver.resolve(HOST_A)).resolves.toMatchObject({ id: A }); // aún en caché (TTL corto)
      await resolver.invalidate(HOST_A);
      await expect(resolver.resolve(HOST_A)).resolves.toBeNull();
      await platform.tenantDomain.update({
        where: { host: HOST_A },
        data: { verificationStatus: 'VERIFIED' },
      });
      await resolver.invalidate(HOST_A);
      await expect(resolver.resolve(HOST_A)).resolves.toMatchObject({ id: A });
    });

    it('§7.6 · 200 requests concurrentes de dos hosts no mezclan el tenant', async () => {
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) => {
          const host = i % 2 === 0 ? HOST_A : HOST_B;
          return request(app.getHttpServer())
            .get('/api/v1/public/site')
            .set('Host', host)
            .then((res) => res.body.tenant?.slug === (host === HOST_A ? 'transportesa' : 'navierab'));
        }),
      );
      expect(results.every(Boolean)).toBe(true);
    });
  });
});
