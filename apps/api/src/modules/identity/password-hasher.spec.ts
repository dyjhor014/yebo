import type { Env } from '../../config/env';
import { ConcurrencyLimiter, PASSWORD_MAX_LENGTH, PasswordHasher } from './password-hasher';

const OWASP = {
  ARGON2_MEMORY_KIB: 19456,
  ARGON2_ITERATIONS: 2,
  ARGON2_PARALLELISM: 1,
  ARGON2_MAX_CONCURRENT: 4,
  ARGON2_MAX_QUEUE: 64,
};

function hasher(params: Partial<typeof OWASP> = {}): PasswordHasher {
  return new PasswordHasher({ ...OWASP, ...params } as Env);
}

describe('PasswordHasher (Argon2id, security.md §1)', () => {
  const h = hasher();

  beforeAll(async () => {
    await h.onModuleInit();
  });

  it('genera un hash PHC de Argon2id con los parámetros configurados y sal aleatoria', async () => {
    const a = await h.hash('correcta-caballo-bateria');
    const b = await h.hash('correcta-caballo-bateria');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(a).not.toBe(b);
  });

  it('verifica la contraseña correcta y rechaza la incorrecta', async () => {
    const stored = await h.hash('correcta-caballo-bateria');
    await expect(h.verify(stored, 'correcta-caballo-bateria')).resolves.toBe(true);
    await expect(h.verify(stored, 'correcta-caballo-bateriA')).resolves.toBe(false);
    await expect(h.verify(stored, '')).resolves.toBe(false);
  });

  it('un hash con formato inválido o parámetros desmesurados no lanza: devuelve false', async () => {
    await expect(h.verify('$argon2id$placeholder', 'x')).resolves.toBe(false);
    await expect(h.verify('$2b$10$abcdefghijklmnopqrstuv', 'x')).resolves.toBe(false);
    await expect(
      h.verify('$argon2id$v=19$m=999999999,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2g', 'x'),
    ).resolves.toBe(false);
  });

  it('una contraseña más larga que el máximo no se calcula', async () => {
    const stored = await h.hash('correcta-caballo-bateria');
    await expect(h.verify(stored, 'x'.repeat(PASSWORD_MAX_LENGTH + 1))).resolves.toBe(false);
    await expect(h.hash('x'.repeat(PASSWORD_MAX_LENGTH + 1))).rejects.toThrow(RangeError);
    await expect(h.hash('')).rejects.toThrow(RangeError);
  });

  it('verifyDummy hace el cálculo y siempre devuelve false (cuenta inexistente)', async () => {
    await expect(h.verifyDummy('cualquiera')).resolves.toBe(false);
  });

  it('needsRehash detecta hashes con parámetros más débiles que los vigentes', async () => {
    const stored = await h.hash('correcta-caballo-bateria');
    expect(h.needsRehash(stored)).toBe(false);
    expect(hasher({ ARGON2_MEMORY_KIB: 65536 }).needsRehash(stored)).toBe(true);
    expect(hasher({ ARGON2_ITERATIONS: 3 }).needsRehash(stored)).toBe(true);
    expect(h.needsRehash('$argon2id$placeholder')).toBe(true);
  });

  it('normaliza NFKC: la misma contraseña escrita con formas Unicode distintas verifica (hallazgo B5)', async () => {
    const stored = await h.hash('oficina-ﬁnal-Å');
    await expect(h.verify(stored, 'oficina-final-Å')).resolves.toBe(true);
  });
});

describe('ConcurrencyLimiter (hallazgo M6)', () => {
  it('limita las tareas simultáneas y encola el resto en orden', async () => {
    const limiter = new ConcurrencyLimiter(2, 10);
    let running = 0;
    let peak = 0;
    const task = () =>
      limiter.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
      });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(2);
  });

  it('con la cola llena responde 503 en lugar de acumular cálculos', async () => {
    const limiter = new ConcurrencyLimiter(1, 1);
    let release: () => void = () => undefined;
    const blocker = limiter.run(() => new Promise<void>((r) => (release = r)));
    const queued = limiter.run(async () => 'encolada');
    await expect(limiter.run(async () => 'rechazada')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      httpStatus: 503,
    });
    release();
    await blocker;
    await expect(queued).resolves.toBe('encolada');
  });
});
