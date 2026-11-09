import { randomBytes } from 'node:crypto';
import { decryptSuccessor, encryptSuccessor, SUCCESSOR_CIPHERTEXT_BYTES } from './successor-crypto';

const token = (): string => randomBytes(32).toString('base64url');
const binding = {
  parentId: '0190f0a0-0000-7000-8000-0000000000aa',
  sessionId: '0190f0a0-0000-7000-8000-0000000000bb',
};

describe('cifrado del sucesor (AES-256-GCM con clave HKDF del token padre)', () => {
  it('ida y vuelta con el token padre; 61 bytes; el sucesor no aparece en claro', () => {
    const parent = token();
    const successor = token();
    const ciphertext = encryptSuccessor(parent, successor, binding);
    expect(ciphertext).toHaveLength(SUCCESSOR_CIPHERTEXT_BYTES);
    expect(ciphertext.includes(Buffer.from(successor, 'base64url'))).toBe(false);
    expect(decryptSuccessor(parent, ciphertext, binding)).toBe(successor);
  });

  it('cada cifrado usa un IV distinto (mismo padre y sucesor → cifrados distintos)', () => {
    const parent = token();
    const successor = token();
    expect(
      encryptSuccessor(parent, successor, binding).equals(encryptSuccessor(parent, successor, binding)),
    ).toBe(false);
  });

  it('sin el token padre correcto no se descifra (el SHA-256 guardado no sirve como clave)', () => {
    const parent = token();
    const ciphertext = encryptSuccessor(parent, token(), binding);
    expect(decryptSuccessor(token(), ciphertext, binding)).toBeNull();
  });

  it('el cifrado está ligado a su fila y a su sesión (datos asociados)', () => {
    const parent = token();
    const ciphertext = encryptSuccessor(parent, token(), binding);
    expect(decryptSuccessor(parent, ciphertext, { ...binding, sessionId: binding.parentId })).toBeNull();
    expect(decryptSuccessor(parent, ciphertext, { ...binding, parentId: binding.sessionId })).toBeNull();
  });

  it('cualquier byte alterado, una versión desconocida o una longitud distinta → null', () => {
    const parent = token();
    const ciphertext = encryptSuccessor(parent, token(), binding);
    for (const position of [0, 5, 20, 50, 60]) {
      const tampered = Buffer.from(ciphertext);
      tampered[position] = (tampered[position] ?? 0) ^ 0x01;
      expect(decryptSuccessor(parent, tampered, binding)).toBeNull();
    }
    expect(decryptSuccessor(parent, ciphertext.subarray(0, 60), binding)).toBeNull();
  });

  it('rechaza tokens con longitud distinta de 256 bits', () => {
    expect(() => encryptSuccessor('corto', token(), binding)).toThrow(RangeError);
    expect(() => encryptSuccessor(token(), 'corto', binding)).toThrow(RangeError);
  });
});
