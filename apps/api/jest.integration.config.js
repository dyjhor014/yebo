/**
 * Pruebas de integración y pruebas de concepto: PostgreSQL y Redis reales (pnpm infra:up).
 * Se ejecutan en serie (--runInBand) porque comparten bases de datos.
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.int-spec\\.ts$',
  globalSetup: '<rootDir>/test/support/global-setup.ts',
  setupFiles: ['<rootDir>/test/support/load-env.ts'],
  testTimeout: 60000,
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
      },
    ],
  },
};
