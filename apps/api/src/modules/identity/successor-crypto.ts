import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Cifrado del sucesor de un refresh token para la ventana de gracia (identity-and-sessions §6).
 *
 * Problema: varias pestañas pueden presentar a la vez el mismo refresh token; todas deben recibir el MISMO
 * sucesor, pero el sucesor no puede guardarse en claro (security.md §1: los refresh tokens solo se guardan hasheados).
 *
 * Solución: el sucesor se cifra con AES-256-GCM usando una clave derivada (HKDF-SHA256) del token PADRE en claro.
 * - La base de datos solo guarda SHA-256(padre): con ese hash no se puede derivar la clave.
 * - Quien presenta el padre (y solo él) puede descifrar el sucesor: exactamente quien tiene derecho a recibirlo.
 * - Sin clave de servidor que gestionar ni rotar; no depende de Redis.
 * Formato: versión (1 byte) ‖ IV (12) ‖ sucesor cifrado (32) ‖ etiqueta GCM (16) = 61 bytes.
 */
const VERSION = 0x01;
const IV_BYTES = 12;
const TOKEN_BYTES = 32;
const TAG_BYTES = 16;
export const SUCCESSOR_CIPHERTEXT_BYTES = 1 + IV_BYTES + TOKEN_BYTES + TAG_BYTES;
const INFO = Buffer.from('yebo:refresh-successor:v1');

export interface SuccessorBinding {
  /** refresh_tokens.id del padre: sal de HKDF y dato asociado (el cifrado no se puede trasladar a otra fila). */
  parentId: string;
  /** tenant_sessions.id: dato asociado (no se puede trasladar a otra sesión). */
  sessionId: string;
}

export function encryptSuccessor(parentRaw: string, successorRaw: string, binding: SuccessorBinding): Buffer {
  const plaintext = decodeToken(successorRaw);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(parentRaw, binding), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad(binding));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(VERSION), iv, body, cipher.getAuthTag()]);
}

/** Devuelve el sucesor en claro, o `null` si el formato, la clave o los datos asociados no coinciden. */
export function decryptSuccessor(
  parentRaw: string,
  ciphertext: Uint8Array,
  binding: SuccessorBinding,
): string | null {
  const data = Buffer.from(ciphertext);
  if (data.length !== SUCCESSOR_CIPHERTEXT_BYTES || data[0] !== VERSION) return null;
  const iv = data.subarray(1, 1 + IV_BYTES);
  const body = data.subarray(1 + IV_BYTES, 1 + IV_BYTES + TOKEN_BYTES);
  const tag = data.subarray(1 + IV_BYTES + TOKEN_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(parentRaw, binding), iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('base64url');
  } catch {
    return null;
  }
}

function deriveKey(parentRaw: string, binding: SuccessorBinding): Buffer {
  const salt = Buffer.from(binding.parentId.replace(/-/g, ''), 'hex');
  return Buffer.from(hkdfSync('sha256', decodeToken(parentRaw), salt, INFO, 32));
}

function aad(binding: SuccessorBinding): Buffer {
  return Buffer.from(`v${VERSION}|${binding.parentId}|${binding.sessionId}`);
}

function decodeToken(raw: string): Buffer {
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length !== TOKEN_BYTES) throw new RangeError('Refresh token con longitud inválida');
  return bytes;
}
