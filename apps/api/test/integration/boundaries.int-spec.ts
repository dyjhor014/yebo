/**
 * Fase 3.2a · Fronteras del contexto privilegiado de identidad (hallazgo M3 de la auditoría) y configuración.
 * - ESLint: PlatformPrismaService e IdentityPrismaService solo se importan donde está autorizado.
 * - Inyección de dependencias: IdentityPrismaService no es inyectable fuera del módulo identity.
 * - Arranque: sin clave de firma o sin credenciales de yebo_identity, la API no arranca.
 * - scripts/dev/init-env.sh: añade las variables nuevas a archivos existentes, sin duplicarlas.
 * - Fase 3.3: @Public() solo en los módulos autorizados; la cadena de guards globales solo en access.module.ts.
 */
import { spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { InvalidConfigurationError } from '../../src/config/env';
import { IdentityPrismaService } from '../../src/modules/identity/identity-prisma.service';

const REPO = resolve(__dirname, '..', '..', '..', '..');

/** Lintea fragmentos de código como si estuvieran en `filePath`, con la configuración real del repositorio. */
function lint(cases: { filePath: string; code: string }[]): { filePath: string; rules: string[] }[] {
  const script = `
    import { ESLint } from 'eslint';
    const eslint = new ESLint({ cwd: process.cwd() });
    const cases = JSON.parse(process.env.LINT_CASES);
    const out = [];
    for (const c of cases) {
      const [r] = await eslint.lintText(c.code, { filePath: c.filePath });
      out.push({ filePath: c.filePath, rules: r.messages.map((m) => m.ruleId) });
    }
    console.log(JSON.stringify(out));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    env: { ...process.env, LINT_CASES: JSON.stringify(cases) },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

const IMPORT_PLATFORM = `import { PlatformPrismaService } from '../../infrastructure/database/platform-prisma.service';\nexport const x = PlatformPrismaService;\n`;
const IMPORT_IDENTITY = `import { IdentityPrismaService } from '../identity/identity-prisma.service';\nexport const y = IdentityPrismaService;\n`;
const PLATFORM_RULE = 'no-restricted-imports';
const IDENTITY_RULE = '@typescript-eslint/no-restricted-imports';

describe('Fase 3.2a · fronteras y configuración', () => {
  describe('ESLint (frontera en el código)', () => {
    let results: Map<string, string[]>;

    beforeAll(() => {
      const files = [
        'apps/api/src/modules/shipments/x.service.ts',
        'apps/api/src/common/x.helper.ts',
        'apps/api/src/infrastructure/queue/x.ts',
        'apps/api/src/worker.module.ts',
        'apps/api/src/modules/identity/x.ts',
        'apps/api/src/modules/tenancy/x.ts',
      ];
      const cases = files.flatMap((f) => [
        { filePath: `${f}#platform`, code: IMPORT_PLATFORM },
        { filePath: `${f}#identity`, code: IMPORT_IDENTITY },
      ]);
      // ESLint necesita la ruta real: el sufijo #… solo identifica el caso.
      const raw = lint(cases.map((c) => ({ ...c, filePath: c.filePath.split('#')[0] ?? '' })));
      results = new Map(raw.map((r, i) => [cases[i]?.filePath ?? '', r.rules]));
    }, 120_000);

    it.each([
      'apps/api/src/modules/shipments/x.service.ts',
      'apps/api/src/common/x.helper.ts',
      'apps/api/src/infrastructure/queue/x.ts',
      'apps/api/src/worker.module.ts',
      'apps/api/src/modules/identity/x.ts',
    ])('PlatformPrismaService está prohibido en %s', (file) => {
      expect(results.get(`${file}#platform`)).toContain(PLATFORM_RULE);
    });

    it('PlatformPrismaService sigue permitido en tenancy (resolver de dominios)', () => {
      expect(results.get('apps/api/src/modules/tenancy/x.ts#platform')).not.toContain(PLATFORM_RULE);
    });

    it.each([
      'apps/api/src/modules/shipments/x.service.ts',
      'apps/api/src/common/x.helper.ts',
      'apps/api/src/infrastructure/queue/x.ts',
      'apps/api/src/worker.module.ts',
      'apps/api/src/modules/tenancy/x.ts',
    ])('IdentityPrismaService (yebo_identity) está prohibido en %s', (file) => {
      expect(results.get(`${file}#identity`)).toContain(IDENTITY_RULE);
    });

    it('IdentityPrismaService solo se permite dentro del módulo identity', () => {
      expect(results.get('apps/api/src/modules/identity/x.ts#identity')).not.toContain(IDENTITY_RULE);
    });
  });

  describe('ESLint · denegar por defecto (frontera 3, Fase 3.3)', () => {
    const PUBLIC_ROUTE = `import { Controller, Get } from '@nestjs/common';\nimport { Public } from '../access/route-policy';\n@Controller('x')\nexport class X {\n  @Public('tenant')\n  @Get()\n  x(): void {}\n}\n`;
    const REGISTER_GUARD = `import { APP_GUARD } from '@nestjs/core';\nexport const p = { provide: APP_GUARD, useValue: { canActivate: () => true } };\n`;
    const USE_GLOBAL = `export function f(app: { useGlobalGuards: (...g: unknown[]) => void }): void {\n  app.useGlobalGuards();\n}\n`;
    const RULE = 'no-restricted-syntax';
    let results: Map<string, string[]>;

    beforeAll(() => {
      const cases = [
        ['apps/api/src/modules/shipments/x.controller.ts', 'public', PUBLIC_ROUTE],
        ['apps/api/src/modules/access/http/x.controller.ts', 'public', PUBLIC_ROUTE],
        ['apps/api/src/modules/identity/x.service.ts', 'public', PUBLIC_ROUTE],
        ['apps/api/src/modules/identity/http/x.controller.ts', 'public', PUBLIC_ROUTE],
        ['apps/api/src/modules/tenancy/x.controller.ts', 'public', PUBLIC_ROUTE],
        ['apps/api/src/modules/health/x.controller.ts', 'public', PUBLIC_ROUTE],
        ['apps/api/src/modules/shipments/x.module.ts', 'guard', REGISTER_GUARD],
        ['apps/api/src/modules/identity/http/x.ts', 'guard', REGISTER_GUARD],
        ['apps/api/src/infrastructure/core.module.ts', 'guard', REGISTER_GUARD],
        ['apps/api/src/modules/access/access.module.ts', 'guard', REGISTER_GUARD],
        ['apps/api/src/main.ts', 'global', USE_GLOBAL],
        ['apps/api/src/modules/access/access.module.ts', 'global', USE_GLOBAL],
      ] as const;
      const raw = lint(cases.map(([filePath, , code]) => ({ filePath, code })));
      results = new Map(raw.map((r, i) => [`${cases[i]?.[0]}#${cases[i]?.[1]}`, r.rules]));
    }, 120_000);

    it.each([
      'apps/api/src/modules/shipments/x.controller.ts',
      'apps/api/src/modules/access/http/x.controller.ts',
      'apps/api/src/modules/identity/x.service.ts',
    ])('@Public() está prohibido en %s', (file) => {
      expect(results.get(`${file}#public`)).toContain(RULE);
    });

    it.each([
      'apps/api/src/modules/identity/http/x.controller.ts',
      'apps/api/src/modules/tenancy/x.controller.ts',
      'apps/api/src/modules/health/x.controller.ts',
    ])('@Public() se permite en %s (y la ruta debe figurar en PUBLIC_ROUTES)', (file) => {
      expect(results.get(`${file}#public`)).not.toContain(RULE);
    });

    it.each([
      'apps/api/src/modules/shipments/x.module.ts',
      'apps/api/src/modules/identity/http/x.ts',
      'apps/api/src/infrastructure/core.module.ts',
    ])('registrar un APP_GUARD está prohibido en %s', (file) => {
      expect(results.get(`${file}#guard`)).toContain(RULE);
    });

    it('APP_GUARD solo se registra en access.module.ts', () => {
      expect(results.get('apps/api/src/modules/access/access.module.ts#guard')).not.toContain(RULE);
    });

    it('useGlobalGuards está prohibido en todo apps/api/src, también en access.module.ts', () => {
      expect(results.get('apps/api/src/main.ts#global')).toContain(RULE);
      expect(results.get('apps/api/src/modules/access/access.module.ts#global')).toContain(RULE);
    });
  });

  describe('inyección de dependencias (frontera en tiempo de ejecución)', () => {
    it('un proveedor de fuera del módulo identity no puede inyectar IdentityPrismaService', async () => {
      @Injectable()
      class Intruder {
        constructor(readonly db: IdentityPrismaService) {}
      }
      await expect(
        Test.createTestingModule({ imports: [AppModule], providers: [Intruder] }).compile(),
      ).rejects.toThrow(/IdentityPrismaService/);
    });
  });

  describe('arranque', () => {
    async function compileWithout(variable: string): Promise<unknown> {
      const previous = process.env[variable];
      delete process.env[variable];
      try {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        await moduleRef.close();
        return null;
      } catch (error) {
        return error;
      } finally {
        process.env[variable] = previous;
      }
    }

    it('sin AUTH_JWT_PRIVATE_KEY la API no arranca', async () => {
      const error = await compileWithout('AUTH_JWT_PRIVATE_KEY');
      expect(error).toBeInstanceOf(InvalidConfigurationError);
      expect(String(error)).toMatch(/AUTH_JWT_PRIVATE_KEY/);
    });

    it('sin AUTH_COOKIE_SECRET la API no arranca', async () => {
      const error = await compileWithout('AUTH_COOKIE_SECRET');
      expect(error).toBeInstanceOf(InvalidConfigurationError);
      expect(String(error)).toMatch(/AUTH_COOKIE_SECRET/);
    });

    it('sin PG_IDENTITY_PASSWORD la API no arranca', async () => {
      const error = await compileWithout('PG_IDENTITY_PASSWORD');
      expect(error).toBeInstanceOf(InvalidConfigurationError);
      expect(String(error)).toMatch(/PG_IDENTITY_PASSWORD/);
    });
  });

  describe('scripts/dev/init-env.sh', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'yebo-init-env-'));
      mkdirSync(join(dir, 'scripts/dev'), { recursive: true });
      mkdirSync(join(dir, 'infrastructure/docker'), { recursive: true });
      mkdirSync(join(dir, 'apps/api'), { recursive: true });
      cpSync(join(REPO, 'scripts/dev/init-env.sh'), join(dir, 'scripts/dev/init-env.sh'));
      cpSync(join(REPO, 'apps/api/.env.example'), join(dir, 'apps/api/.env.example'));
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const run = (): string => {
      const r = spawnSync('bash', [join(dir, 'scripts/dev/init-env.sh')], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    const count = (file: string, prefix: string): number =>
      readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((l) => l.startsWith(prefix)).length;

    it('en archivos existentes añade la clave Ed25519 y la contraseña de yebo_identity una sola vez', () => {
      writeFileSync(join(dir, 'infrastructure/docker/.env'), 'PG_PORT=5433\nPG_APP_PASSWORD=existente\n');
      writeFileSync(join(dir, 'apps/api/.env'), 'PG_APP_PASSWORD=existente\n');
      run();
      run();
      expect(count('apps/api/.env', 'AUTH_JWT_PRIVATE_KEY=')).toBe(1);
      expect(count('apps/api/.env', 'AUTH_COOKIE_SECRET=')).toBe(1);
      expect(count('apps/api/.env', 'PG_IDENTITY_PASSWORD=')).toBe(1);
      expect(count('infrastructure/docker/.env', 'PG_IDENTITY_PASSWORD=')).toBe(1);
      // Las variables existentes no se tocan y las dos contraseñas coinciden.
      expect(count('apps/api/.env', 'PG_APP_PASSWORD=existente')).toBe(1);
      const value = (file: string, key: string): string =>
        readFileSync(join(dir, file), 'utf8')
          .split('\n')
          .find((l) => l.startsWith(`${key}=`))
          ?.slice(key.length + 1) ?? '';
      expect(value('apps/api/.env', 'PG_IDENTITY_PASSWORD')).toBe(
        value('infrastructure/docker/.env', 'PG_IDENTITY_PASSWORD'),
      );
      const key = createPrivateKey(
        Buffer.from(value('apps/api/.env', 'AUTH_JWT_PRIVATE_KEY'), 'base64').toString(),
      );
      expect(key.asymmetricKeyType).toBe('ed25519');
    });

    it('desde cero genera ambos archivos con todas las credenciales', () => {
      run();
      for (const k of [
        'PG_IDENTITY_PASSWORD=',
        'AUTH_JWT_PRIVATE_KEY=',
        'AUTH_COOKIE_SECRET=',
        'PG_APP_PASSWORD=',
      ]) {
        expect(count('apps/api/.env', k)).toBe(1);
      }
      expect(readFileSync(join(dir, 'apps/api/.env'), 'utf8')).not.toContain('change-me');
      expect(count('infrastructure/docker/.env', 'PG_IDENTITY_PASSWORD=')).toBe(1);
    });
  });
});
