import { createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP (RFC 6238) con HMAC-SHA1, 6 dígitos y pasos de 30 s: el formato que entienden todas las apps de
 * autenticación. Sin dependencias. Se acepta ±1 paso de desfase de reloj, y nunca un paso igual o anterior al
 * último aceptado (un código no se puede reutilizar, RFC 6238 §5.2).
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const SECRET_BYTES = 20; // 160 bits (RFC 4226 §4)
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** Código HOTP del paso dado (RFC 4226 §5.3), con el número de dígitos indicado. */
export function hotp(secret: Buffer, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Comprueba un código. Devuelve el paso aceptado (para guardarlo como último usado) o `null`.
 * Recorre siempre los tres pasos candidatos, para que el tiempo no dependa de cuál coincide.
 */
export function verifyTotp(secret: Buffer, code: string, now: Date, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(now);
  let accepted: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const matches = timingSafeEqualString(hotp(secret, step), code);
    if (matches && accepted === null && (lastStep === null || step > lastStep)) accepted = step;
  }
  return accepted;
}

export function otpauthUri(secret: Buffer, account: string, issuer = 'YEBO Admin'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
