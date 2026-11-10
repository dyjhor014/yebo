import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

/** TOTP (RFC 6238, SHA-1, 30 s, 6 dígitos), como una app de autenticación. Igual que scripts/dev/totp-code.mjs. */
export function totp(base32: string, now = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.toUpperCase().replace(/[\s=-]/g, ''))
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * Código para el siguiente intento. La API rechaza reutilizar el paso ya usado (anti-reutilización), así que si
 * se ha usado `usedStep`, espera al siguiente paso de 30 s.
 */
export async function freshCode(base32: string, usedStep?: number): Promise<{ code: string; step: number }> {
  let step = Math.floor(Date.now() / 30_000);
  if (usedStep !== undefined && step <= usedStep) {
    await new Promise((r) => setTimeout(r, (usedStep + 1) * 30_000 - Date.now() + 200));
    step = Math.floor(Date.now() / 30_000);
  }
  return { code: totp(base32), step };
}
