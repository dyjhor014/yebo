import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';

/**
 * Límite de intentos por ventana fija (security.md §1: fuerza bruta). Redis comparte el contador entre
 * procesos; si Redis falla, se usa un contador en memoria del proceso (degradado, nunca "sin límite").
 * Las claves nunca contienen datos personales en claro (el correo llega ya hasheado).
 */
@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly local = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly redis: RedisService) {}

  /** Cuenta un intento. `allowed` es falso si con este intento se supera el límite de la ventana. */
  async hit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const fullKey = `rl:${key}`;
    try {
      const results = await this.redis.client
        .multi()
        .incr(fullKey)
        .expire(fullKey, windowSeconds, 'NX')
        .ttl(fullKey)
        .exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      const ttl = Number(results?.[2]?.[1] ?? windowSeconds);
      return { allowed: count <= limit, retryAfterSeconds: Math.max(1, ttl) };
    } catch (error) {
      this.logger.warn({ err: error }, 'Límite de intentos sin Redis: contador local del proceso');
      return this.localHit(fullKey, limit, windowSeconds);
    }
  }

  /** Intentos ya contados en la ventana (sin contar uno nuevo). */
  async count(key: string): Promise<number> {
    const fullKey = `rl:${key}`;
    try {
      return Number((await this.redis.client.get(fullKey)) ?? 0);
    } catch {
      const entry = this.local.get(fullKey);
      return entry && entry.resetAt > Date.now() ? entry.count : 0;
    }
  }

  async reset(key: string): Promise<void> {
    const fullKey = `rl:${key}`;
    this.local.delete(fullKey);
    try {
      await this.redis.client.del(fullKey);
    } catch {
      // El contador expira solo; no se bloquea el login por no poder reiniciarlo.
    }
  }

  private localHit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    let entry = this.local.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.local.set(key, entry);
    }
    entry.count++;
    if (this.local.size > 10_000) {
      for (const [k, v] of this.local) if (v.resetAt <= now) this.local.delete(k);
    }
    return {
      allowed: entry.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
}
