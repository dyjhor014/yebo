import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ENV } from '../../config/env.module';
import { InvalidConfigurationError, type Env } from '../../config/env';
import { Clock } from './clock';

/** Claims mínimos del access token (security.md §1; identity-and-sessions §7). */
export interface AccessTokenSubject {
  /** Usuario. */
  sub: string;
  /** Sesión de empresa (tenant_sessions.id). */
  sid: string;
  /** Tenant. Debe coincidir con el tenant resuelto por el host (ADR-004). */
  tid: string;
  /** Membresía. */
  mid: string;
  /** permissions_version de la membresía al emitir el token. */
  ver: number;
}

export interface AccessTokenClaims extends AccessTokenSubject {
  iss: string;
  /** Audiencia: solo la API de empresas acepta estos tokens (un token de plataforma tendría otra). */
  aud: string;
  iat: number;
  exp: number;
}

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

const ALG = 'EdDSA';
/** Tolerancia de reloj entre procesos. Pequeña: los tokens duran como máximo 15 minutos. */
const CLOCK_SKEW_SECONDS = 5;
/** Vida máxima aceptada (exp − iat), igual al máximo configurable de AUTH_ACCESS_TOKEN_TTL_SECONDS. */
export const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 900;
const MAX_TOKEN_LENGTH = 2048;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ED25519_SIGNATURE_BYTES = 64;

const HeaderSchema = z.strictObject({ alg: z.literal(ALG), typ: z.literal('JWT'), kid: z.string().min(1) });
const ClaimsSchema = z.strictObject({
  iss: z.string(),
  aud: z.string(),
  sub: z.uuid(),
  sid: z.uuid(),
  tid: z.uuid(),
  mid: z.uuid(),
  ver: z.number().int().positive(),
  iat: z.number().int(),
  exp: z.number().int(),
});
const PreviousKeysSchema = z.array(z.strictObject({ kid: z.string().min(1), key: z.string().min(1) }));

/**
 * Access tokens JWT firmados con Ed25519 (EdDSA), con `crypto` de Node: sin dependencias de terceros.
 * La verificación es estricta: solo acepta `alg: EdDSA` y un `kid` conocido (nunca `none` ni otro algoritmo),
 * valida la firma antes de leer los claims y rechaza cualquier claim inesperado.
 */
@Injectable()
export class AccessTokenService {
  private readonly signingKey: KeyObject;
  private readonly kid: string;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly ttlSeconds: number;
  private readonly verificationKeys = new Map<string, KeyObject>();

  constructor(
    @Inject(ENV) env: Env,
    private readonly clock: Clock,
  ) {
    if (!env.AUTH_JWT_PRIVATE_KEY) {
      throw new InvalidConfigurationError(['AUTH_JWT_PRIVATE_KEY: obligatoria para el módulo de identidad']);
    }
    this.signingKey = loadKey(
      () => createPrivateKey(decodePem(env.AUTH_JWT_PRIVATE_KEY ?? '')),
      'AUTH_JWT_PRIVATE_KEY',
    );
    this.kid = env.AUTH_JWT_KEY_ID;
    this.issuer = env.AUTH_JWT_ISSUER;
    this.audience = env.AUTH_JWT_AUDIENCE;
    this.ttlSeconds = Math.min(env.AUTH_ACCESS_TOKEN_TTL_SECONDS, MAX_ACCESS_TOKEN_LIFETIME_SECONDS);
    this.verificationKeys.set(this.kid, createPublicKey(this.signingKey));

    const previous = parsePreviousKeys(env.AUTH_JWT_PREVIOUS_PUBLIC_KEYS);
    for (const { kid, key } of previous) {
      if (this.verificationKeys.has(kid)) {
        throw new InvalidConfigurationError([`AUTH_JWT_PREVIOUS_PUBLIC_KEYS: kid repetido (${kid})`]);
      }
      this.verificationKeys.set(
        kid,
        loadKey(() => createPublicKey(decodePem(key)), `AUTH_JWT_PREVIOUS_PUBLIC_KEYS[${kid}]`),
      );
    }
  }

  sign(subject: AccessTokenSubject): SignedAccessToken {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const exp = iat + this.ttlSeconds;
    const claims: AccessTokenClaims = { iss: this.issuer, aud: this.audience, ...subject, iat, exp };
    const header = encode({ alg: ALG, typ: 'JWT', kid: this.kid });
    const payload = encode(claims);
    const signature = sign(null, Buffer.from(`${header}.${payload}`), this.signingKey).toString('base64url');
    return { token: `${header}.${payload}.${signature}`, expiresAt: new Date(exp * 1000) };
  }

  /** Devuelve los claims o lanza `UNAUTHENTICATED`. El motivo concreto no se expone al cliente. */
  verify(token: string): AccessTokenClaims {
    const claims = this.tryVerify(token);
    if (!claims) throw new AppError('UNAUTHENTICATED', 'Sesión no válida', 401);
    return claims;
  }

  private tryVerify(token: string): AccessTokenClaims | null {
    if (token.length > MAX_TOKEN_LENGTH || !COMPACT_JWS.test(token)) return null;
    const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = token.split('.');

    const header = HeaderSchema.safeParse(decode(encodedHeader));
    if (!header.success) return null;
    const key = this.verificationKeys.get(header.data.kid);
    if (!key) return null;

    const signature = Buffer.from(encodedSignature, 'base64url');
    if (signature.length !== ED25519_SIGNATURE_BYTES) return null;
    if (!verify(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), key, signature)) return null;

    const claims = ClaimsSchema.safeParse(decode(encodedPayload));
    if (!claims.success || claims.data.iss !== this.issuer || claims.data.aud !== this.audience) return null;
    const now = Math.floor(this.clock.now().getTime() / 1000);
    if (claims.data.exp <= now - CLOCK_SKEW_SECONDS) return null;
    if (claims.data.iat > now + CLOCK_SKEW_SECONDS || claims.data.exp <= claims.data.iat) return null;
    if (claims.data.exp - claims.data.iat > MAX_ACCESS_TOKEN_LIFETIME_SECONDS) return null;
    return claims.data;
  }
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Las claves se configuran como PEM codificado en base64 (una línea), para no lidiar con saltos de línea. */
function decodePem(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function loadKey(load: () => KeyObject, name: string): KeyObject {
  let key: KeyObject;
  try {
    key = load();
  } catch {
    throw new InvalidConfigurationError([`${name}: no es una clave PEM válida`]);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new InvalidConfigurationError([`${name}: debe ser una clave Ed25519`]);
  }
  return key;
}

function parsePreviousKeys(raw: string): z.infer<typeof PreviousKeysSchema> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new InvalidConfigurationError(['AUTH_JWT_PREVIOUS_PUBLIC_KEYS: JSON inválido']);
  }
  const parsed = PreviousKeysSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidConfigurationError(['AUTH_JWT_PREVIOUS_PUBLIC_KEYS: formato inválido']);
  }
  return parsed.data;
}
