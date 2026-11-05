import { Inject, Injectable } from '@nestjs/common';
import type { HealthResponse } from '@yebo/contracts';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';
import { AppPrismaService } from '../../infrastructure/database/app-prisma.service';
import { PlatformPrismaService } from '../../infrastructure/database/platform-prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

export const HEALTH_SERVICE_NAME = Symbol('HEALTH_SERVICE_NAME');
const CHECK_TIMEOUT_MS = 2000;

type Check = HealthResponse['checks'][string];

class CheckTimeoutError extends Error {
  constructor() {
    super(`tiempo de espera agotado (${CHECK_TIMEOUT_MS} ms)`);
  }
}

async function timed(probe: () => Promise<unknown>): Promise<Check> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeoutError()), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    // Solo el tipo de error: los mensajes de drivers pueden incluir hosts o usuarios.
    const message = error instanceof CheckTimeoutError ? error.message : 'no disponible';
    return { status: 'down', latencyMs: Math.round(performance.now() - started), message };
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(HEALTH_SERVICE_NAME) private readonly service: HealthResponse['service'],
    private readonly appPrisma: AppPrismaService,
    private readonly platformPrisma: PlatformPrismaService,
    private readonly redis: RedisService,
  ) {}

  async readiness(): Promise<HealthResponse> {
    const [databaseApp, databasePlatform, redis] = await Promise.all([
      timed(() => this.appPrisma.client.$queryRaw`SELECT 1`),
      timed(() => this.platformPrisma.client.$queryRaw`SELECT 1`),
      timed(async () => {
        if (this.redis.client.status === 'wait') await this.redis.client.connect();
        return this.redis.client.ping();
      }),
    ]);
    const checks = { databaseApp, databasePlatform, redis };
    const ok = Object.values(checks).every((check) => check.status === 'up');
    return { status: ok ? 'ok' : 'error', service: this.service, version: this.env.APP_VERSION, checks };
  }
}
