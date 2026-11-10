import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { ADMIN_URL, API_ENV, E2E, ROOT } from './support/env';

/**
 * Recorridos E2E del panel del staff (Fase 4.7c). Requieren `pnpm infra:up` y las apps compiladas
 * (`pnpm test:e2e` desde la raíz compila antes). Un solo worker: el recorrido comparte datos y va en orden.
 *  - acceso: login y activación de la MFA (guarda la sesión para los demás);
 *  - recorrido: la maqueta 4.7 v2 de punta a punta, con axe en cada pantalla y diálogo;
 *  - accesibilidad en modo oscuro y en móvil (390 px): axe y sin desplazamiento horizontal.
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  outputDir: 'results',
  globalSetup: './support/global-setup.ts',
  use: {
    baseURL: ADMIN_URL,
    locale: 'es-PE',
    timezoneId: 'America/Lima',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'acceso',
      testMatch: /01-.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'recorrido',
      testMatch: /02-.*\.spec\.ts/,
      dependencies: ['acceso'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: '.auth/staff.json',
      },
    },
    {
      name: 'oscuro',
      testMatch: /03-.*\.spec\.ts/,
      dependencies: ['recorrido'],
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark', storageState: '.auth/staff.json' },
    },
    {
      name: 'movil',
      testMatch: /03-.*\.spec\.ts/,
      dependencies: ['recorrido'],
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, storageState: '.auth/staff.json' },
    },
    {
      name: 'portal',
      testMatch: /06-.*\.spec\.ts/,
      dependencies: ['recorrido'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'capturas',
      testMatch: /0[45]-.*\.spec\.ts/,
      dependencies: ['recorrido'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: '.auth/staff.json',
      },
    },
  ],
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: resolve(ROOT, 'apps/api'),
      env: { ...(process.env as Record<string, string>), ...API_ENV },
      url: `http://127.0.0.1:${E2E.apiPort}/api/v1/health/ready`,
      // Con LOG_LEVEL=warn solo salen avisos y errores: visibles al depurar un fallo del recorrido.
      stdout: 'pipe',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `./node_modules/.bin/next start --hostname 127.0.0.1 --port ${E2E.nextPort}`,
      cwd: resolve(ROOT, 'apps/platform'),
      env: { ...(process.env as Record<string, string>), NODE_ENV: 'production' },
      url: `http://127.0.0.1:${E2E.nextPort}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `./node_modules/.bin/next start --hostname 127.0.0.1 --port ${E2E.webPort}`,
      cwd: resolve(ROOT, 'apps/web'),
      env: {
        ...(process.env as Record<string, string>),
        API_INTERNAL_URL: `http://127.0.0.1:${E2E.apiPort}`,
        NODE_ENV: 'production',
      },
      url: `http://127.0.0.1:${E2E.webPort}/estado`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Mismo origen por host, como Nginx: /api → API; admin.* → panel; el resto (hub y empresas) → web.
      command: `node support/proxy.mjs ${E2E.platformPort} ${E2E.apiPort} ${E2E.nextPort} ${E2E.webPort}`,
      url: `http://127.0.0.1:${E2E.platformPort}/login`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
