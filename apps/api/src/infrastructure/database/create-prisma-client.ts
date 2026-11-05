import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

export interface PrismaPoolOptions {
  connectionString: string;
  max: number;
  applicationName: string;
}

/** Prisma 7 usa adaptadores de driver: el pool lo gestiona node-postgres. */
export function createPrismaClient(options: PrismaPoolOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
  });
  return new PrismaClient({ adapter });
}
