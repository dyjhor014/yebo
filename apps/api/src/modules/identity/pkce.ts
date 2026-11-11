import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * PKCE (RFC 7636), solo S256.
 * - code_verifier: 43–128 caracteres de [A-Z a-z 0-9 - . _ ~] (§4.1).
 * - code_challenge = BASE64URL(SHA256(ASCII(code_verifier))), sin relleno: 43 caracteres (§4.2).
 */
export const CODE_VERIFIER_FORMAT = /^[A-Za-z0-9\-._~]{43,128}$/;
export const CODE_CHALLENGE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
/** Códigos de autorización y `state`: 256 bits en base64url (≥ 128 bits exigidos). */
export const OPAQUE_TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Verifier de 43 caracteres (256 bits de entropía), dentro del rango 43–128 de RFC 7636. */
export function newCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Comparación en tiempo constante del reto calculado con el guardado. */
export function verifyCodeChallenge(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER_FORMAT.test(verifier) || !CODE_CHALLENGE_FORMAT.test(challenge)) return false;
  const computed = Buffer.from(codeChallengeS256(verifier));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** Comparación en tiempo constante de dos cadenas (p. ej., `state` y token CSRF). */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
