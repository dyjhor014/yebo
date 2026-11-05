import { resolve } from 'node:path';
import { loadEnvFileIfPresent } from '../../src/config/load-env-file';

// Las pruebas de integración usan SIEMPRE la base yebo_test, nunca la de desarrollo.
loadEnvFileIfPresent(resolve(__dirname, '..', '..', '.env'));
process.env.PG_DATABASE = 'yebo_test';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.LOG_PRETTY = 'false';
