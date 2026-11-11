/**
 * Saturación del pool de PostgreSQL (diagnóstico del 2026-11-10). Antes, una transacción que no conseguía conexión
 * en 2 s (la `maxWait` por defecto de Prisma) acababa en un 500: así fallaba de forma intermitente la prueba de 600
 * lecturas de isolation-e2e. Ahora la espera es `PG_TX_MAX_WAIT_MS` (10 s por defecto) y, si se agota, la API
 * responde 503 con Retry-After. Pool de UNA conexión: el resultado es determinista.
 */
import { mapException } from '../../src/common/errors/global-exception.filter';
import { parseEnv } from '../../src/config/env';
import { AppPrismaService } from '../../src/infrastructure/database/app-prisma.service';

const TRANSACTIONS = 25;
/** 25 × 120 ms ≈ 3 s de cola: más que los 2 s por defecto de Prisma. */
const HOLD_SECONDS = 0.12;

async function burst(overrides: Record<string, string>): Promise<PromiseSettledResult<number>[]> {
  const db = new AppPrismaService(
    parseEnv({ ...process.env, PG_DATABASE: 'yebo_test', PG_POOL_MAX: '1', ...overrides }),
  );
  try {
    return await Promise.allSettled(
      Array.from({ length: TRANSACTIONS }, () =>
        db.client.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_sleep(${HOLD_SECONDS})`;
          return 1;
        }),
      ),
    );
  } finally {
    await db.onModuleDestroy();
  }
}

describe('saturación del pool de PostgreSQL', () => {
  it('con la espera por defecto (10 s), una cola de ~3 s termina sin errores', async () => {
    const results = await burst({});
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
  });

  it('si la espera se agota, el error es P2028 y la API lo traduce a 503 reintentable (nunca 500)', async () => {
    const results = await burst({ PG_TX_MAX_WAIT_MS: '300' });
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of rejected) {
      expect((r.reason as { code?: string }).code).toBe('P2028');
      expect(mapException(r.reason)).toMatchObject({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        retryAfterSeconds: 1,
      });
    }
  });
});
