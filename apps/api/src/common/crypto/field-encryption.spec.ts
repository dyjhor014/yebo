import { randomBytes } from 'node:crypto';
import type { Env } from '../../config/env';
import { FieldEncryption } from './field-encryption';

const env = (key = randomBytes(32).toString('base64'), version = 1) =>
  ({ FIELD_ENCRYPTION_KEY: key, FIELD_ENCRYPTION_KEY_VERSION: version }) as Env;

describe('FieldEncryption (ADR-019)', () => {
  const key = randomBytes(32).toString('base64');
  const fe = new FieldEncryption(env(key));

  it('cifra y descifra; dos cifrados del mismo valor son distintos (IV aleatorio)', () => {
    const a = fe.encrypt(Buffer.from('secreto'), 'tabla.col:1');
    const b = fe.encrypt(Buffer.from('secreto'), 'tabla.col:1');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(fe.decrypt(a, 'tabla.col:1').toString()).toBe('secreto');
    expect(a.keyVersion).toBe(1);
  });

  it('el AAD liga el dato a su fila: con otro AAD no se descifra', () => {
    const a = fe.encrypt(Buffer.from('secreto'), 'tabla.col:1');
    expect(() => fe.decrypt(a, 'tabla.col:2')).toThrow();
  });

  it('un byte alterado, otra clave u otra versión fallan cerrado', () => {
    const a = fe.encrypt(Buffer.from('secreto'), 'x');
    const tampered = Buffer.from(a.ciphertext);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => fe.decrypt({ ...a, ciphertext: tampered }, 'x')).toThrow();
    expect(() => new FieldEncryption(env()).decrypt(a, 'x')).toThrow();
    expect(() => fe.decrypt({ ...a, keyVersion: 2 }, 'x')).toThrow(/Versión de clave/);
    expect(() => fe.decrypt({ ...a, ciphertext: a.ciphertext.subarray(0, 10) }, 'x')).toThrow();
  });

  it('sin clave configurada no arranca', () => {
    expect(() => new FieldEncryption({ FIELD_ENCRYPTION_KEY_VERSION: 1 } as Env)).toThrow(
      /FIELD_ENCRYPTION_KEY/,
    );
  });
});
