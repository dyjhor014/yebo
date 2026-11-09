/**
 * Mediciones (Fase 3.4): NO forman parte de CI, porque los tiempos dependen de la máquina. Usan la misma
 * infraestructura que la integración (yebo_test). Ejecutar con `pnpm --filter @yebo/api bench`.
 */
const integration = require('./jest.integration.config.js');

/** @type {import('jest').Config} */
module.exports = { ...integration, testRegex: '.*\\.bench-spec\\.ts$', testTimeout: 600000 };
