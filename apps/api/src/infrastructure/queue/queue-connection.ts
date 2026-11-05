import type { ConnectionOptions } from 'bullmq';
import type { Env } from '../../config/env';

/** Conexión BullMQ. `maxRetriesPerRequest: null` es obligatorio para los workers de BullMQ. */
export function buildQueueConnection(env: Env): ConnectionOptions {
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
  };
}
