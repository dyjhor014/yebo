import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadEnvFileIfPresent } from '../../src/config/load-env-file';

const API_ROOT = resolve(__dirname, '..', '..');
const PRISMA_CLI = require.resolve('prisma/build/index.js', { paths: [API_ROOT] });

/** Aplica las migraciones (como yebo_owner) en la base de pruebas y en las bases de las pruebas de concepto. */
export default function globalSetup(): void {
  loadEnvFileIfPresent(resolve(API_ROOT, '.env'));
  const deploy = (config: string, extraEnv: Record<string, string> = {}): void => {
    execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--config', config], {
      cwd: API_ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: 'pipe',
    });
  };
  deploy('prisma.config.ts', { PG_DATABASE: 'yebo_test' });
  deploy('test/poc/tenancy/prisma.config.ts');
  deploy('test/poc/inventory/prisma.config.ts');
}
