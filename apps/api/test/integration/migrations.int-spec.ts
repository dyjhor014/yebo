import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const API_ROOT = resolve(__dirname, '..', '..');
const PRISMA_CLI = require.resolve('prisma/build/index.js', { paths: [API_ROOT] });

/**
 * Deriva entre migraciones y esquema Prisma. Detecta, por ejemplo, restricciones creadas con SQL
 * que Prisma intentaría eliminar en la siguiente migración (hallazgo de la PoC-2, ADR-024).
 */
describe.each([
  ['producción', 'prisma.config.ts', 'prisma/migrations', 'prisma/schema.prisma'],
  [
    'PoC aislamiento',
    'test/poc/tenancy/prisma.config.ts',
    'test/poc/tenancy/migrations',
    'test/poc/tenancy/schema.prisma',
  ],
  [
    'PoC inventario',
    'test/poc/inventory/prisma.config.ts',
    'test/poc/inventory/migrations',
    'test/poc/inventory/schema.prisma',
  ],
])('migraciones · %s', (_name, config, migrations, schema) => {
  it('no hay diferencias entre las migraciones y el esquema', () => {
    const result = spawnSync(
      process.execPath,
      [
        PRISMA_CLI,
        'migrate',
        'diff',
        '--config',
        config,
        '--from-migrations',
        migrations,
        '--to-schema',
        schema,
        '--exit-code',
      ],
      { cwd: API_ROOT, env: process.env, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(`Deriva detectada (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
  });
});
