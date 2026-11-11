import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadEnvFileIfPresent } from '../../src/config/load-env-file';
import { grantTestBypass } from './db';

const API_ROOT = resolve(__dirname, '..', '..');
const PRISMA_CLI = require.resolve('prisma/build/index.js', { paths: [API_ROOT] });

/**
 * Aplica las migraciones (como yebo_owner) en la base de pruebas y en las bases de las pruebas de concepto, y
 * después concede al rol exclusivo de pruebas sus permisos de tabla (ADR-034; nunca en una migración).
 */
export default async function globalSetup(): Promise<void> {
  loadEnvFileIfPresent(resolve(API_ROOT, '.env'));
  loadEnvFileIfPresent(resolve(API_ROOT, '.env.test'));
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
  for (const database of ['yebo_test', 'yebo_poc_tenancy', 'yebo_poc_inventory']) {
    await grantTestBypass(database);
  }
}
