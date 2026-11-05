import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Carga apps/api/.env en desarrollo si existe (Node >= 21: process.loadEnvFile).
 * Las variables ya definidas en el entorno tienen prioridad. En producción no existe el archivo.
 */
export function loadEnvFileIfPresent(file = resolve(__dirname, '..', '..', '.env')): void {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}
