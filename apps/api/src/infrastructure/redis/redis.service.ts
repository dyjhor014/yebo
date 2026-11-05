import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';

/** Cliente Redis para caché y rate limit. Redis nunca es fuente de verdad (ADR-007). */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.client = new Redis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      connectionName: 'yebo-api',
    });
  }

  /**
   * `quit()` es un comando más: si la conexión nunca se abrió (`wait`, por `lazyConnect`) la abriría
   * solo para cerrarla, y si Redis no responde (`reconnecting`) esperaría a los reintentos y fallaría.
   * Solo una conexión lista se cierra de forma ordenada; en cualquier otro estado se desconecta.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.client.status === 'ready') {
      await this.client.quit();
    } else if (this.client.status !== 'end') {
      this.client.disconnect();
    }
  }
}
