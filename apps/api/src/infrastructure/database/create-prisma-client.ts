import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

export interface PrismaPoolOptions {
  connectionString: string;
  max: number;
  applicationName: string;
  /**
   * Espera máxima para iniciar una transacción interactiva cuando el pool está lleno (`PG_TX_MAX_WAIT_MS`). El valor
   * por defecto de Prisma (2 s) convertía los picos de carga en errores 500 (diagnóstico del 2026-11-10).
   */
  txMaxWaitMs: number;
}

/** Prisma 7 usa adaptadores de driver: el pool lo gestiona node-postgres. */
export function createPrismaClient(options: PrismaPoolOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
  });
  return new PrismaClient({ adapter, transactionOptions: { maxWait: options.txMaxWaitMs } });
}
