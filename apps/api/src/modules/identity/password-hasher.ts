import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';

/** Parámetros de Argon2id (security.md §1). Los mínimos de OWASP los impone el esquema de entorno. */
export interface Argon2Params {
  /** Memoria en KiB. */
  memory: number;
  /** Iteraciones (t). */
  passes: number;
  /** Paralelismo (p). */
  parallelism: number;
}

const VERSION = 19; // 0x13
const SALT_BYTES = 16;
const TAG_BYTES = 32;
/** Una contraseña más larga no aporta seguridad y solo encarece el cálculo. */
export const PASSWORD_MAX_LENGTH = 1024;
/** Máximo de memoria aceptado al leer un hash guardado: el mismo tope que admite la configuración (1 GiB). */
const MAX_STORED_MEMORY_KIB = 1_048_576;

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface ParsedHash {
  params: Argon2Params;
  salt: Buffer;
  tag: Buffer;
}

/**
 * Hash de contraseñas con Argon2id, usando `crypto.argon2` de Node 24 (sin dependencias nativas de terceros).
 * Formato PHC estándar: `$argon2id$v=19$m=…,t=…,p=…$<sal>$<hash>` (base64 sin relleno).
 */
@Injectable()
export class PasswordHasher implements OnModuleInit {
  private readonly params: Argon2Params;
  private readonly limiter: ConcurrencyLimiter;
  private dummyHash = '';

  constructor(@Inject(ENV) env: Env) {
    this.params = {
      memory: env.ARGON2_MEMORY_KIB,
      passes: env.ARGON2_ITERATIONS,
      parallelism: env.ARGON2_PARALLELISM,
    };
    this.limiter = new ConcurrencyLimiter(env.ARGON2_MAX_CONCURRENT, env.ARGON2_MAX_QUEUE);
  }

  /** Hash de referencia para igualar el tiempo de respuesta cuando la cuenta no existe (anti-enumeración). */
  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(randomBytes(24).toString('base64url'));
  }

  async hash(password: string): Promise<string> {
    const normalized = normalize(password);
    assertLength(normalized);
    const salt = randomBytes(SALT_BYTES);
    const tag = await this.limiter.run(() => derive(normalized, salt, this.params));
    const { memory, passes, parallelism } = this.params;
    return `$argon2id$v=${VERSION}$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
  }

  /** `false` ante una contraseña errónea o un hash con formato inválido; nunca lanza por la contraseña. */
  async verify(stored: string, password: string): Promise<boolean> {
    const normalized = normalize(password);
    if (normalized.length > PASSWORD_MAX_LENGTH) return false;
    const parsed = parse(stored);
    if (!parsed) return false;
    const tag = await this.limiter.run(() =>
      derive(normalized, parsed.salt, parsed.params, parsed.tag.length),
    );
    return tag.length === parsed.tag.length && timingSafeEqual(tag, parsed.tag);
  }

  /**
   * Ejecuta un cálculo equivalente al de una verificación real y devuelve siempre `false`.
   * Se usa cuando la cuenta no existe, para que el tiempo de respuesta no la delate.
   */
  async verifyDummy(password: string): Promise<false> {
    await this.verify(this.dummyHash, password.slice(0, PASSWORD_MAX_LENGTH));
    return false;
  }

  /** El hash se generó con parámetros más débiles que los vigentes: se rehace en el próximo login correcto. */
  needsRehash(stored: string): boolean {
    const parsed = parse(stored);
    if (!parsed) return true;
    const { memory, passes, parallelism } = parsed.params;
    return (
      memory < this.params.memory || passes < this.params.passes || parallelism < this.params.parallelism
    );
  }
}

/**
 * NFKC (hallazgo B5): la misma contraseña escrita con formas Unicode distintas (p. ej., "ﬁ" y "fi", o letras
 * compuestas y precompuestas) produce el mismo hash, sin depender del teclado o del sistema operativo.
 */
function normalize(password: string): string {
  return password.normalize('NFKC');
}

/**
 * Tope de cálculos de Argon2id simultáneos por proceso, con cola acotada (hallazgo M6). Cada cálculo reserva
 * ARGON2_MEMORY_KIB de memoria y un hilo del pool de libuv. Si la cola está llena, se responde 503 en lugar de
 * agotar la memoria o bloquear el resto de operaciones del pool.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxQueue) {
        throw new AppError('SERVICE_UNAVAILABLE', 'Servicio ocupado; reintenta en unos segundos', 503);
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

function assertLength(password: string): void {
  if (password.length === 0 || password.length > PASSWORD_MAX_LENGTH) {
    throw new RangeError('Longitud de contraseña fuera de rango');
  }
}

function derive(
  password: string,
  salt: Buffer,
  params: Argon2Params,
  tagLength = TAG_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        parallelism: params.parallelism,
        tagLength,
        memory: params.memory,
        passes: params.passes,
      },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

function parse(stored: string): ParsedHash | null {
  const match = PHC.exec(stored);
  if (!match) return null;
  const [, m, t, p, salt, tag] = match;
  const params = { memory: Number(m), passes: Number(t), parallelism: Number(p) };
  // Valores absurdos en un hash almacenado no deben poder disparar un cálculo enorme.
  if (params.memory > MAX_STORED_MEMORY_KIB || params.passes > 20 || params.parallelism > 16) return null;
  const saltBuf = Buffer.from(salt ?? '', 'base64');
  const tagBuf = Buffer.from(tag ?? '', 'base64');
  if (saltBuf.length < 8 || tagBuf.length < 16) return null;
  return { params, salt: saltBuf, tag: tagBuf };
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=+$/, '');
}
