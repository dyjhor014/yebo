import { base32Encode, hotp, otpauthUri, totpStep, verifyTotp } from './totp';

// Vectores del Apéndice B de RFC 6238 (SHA-1, clave ASCII "12345678901234567890", 8 dígitos).
const SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(RFC_VECTORS)('vector oficial t=%i → %s', (seconds, expected) => {
    expect(hotp(SECRET, totpStep(new Date(seconds * 1000)), 8)).toBe(expected);
  });

  it('base32 (RFC 4648): "foobar" → MZXW6YTBOI', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('acepta el paso actual y ±1; rechaza ±2', () => {
    const now = new Date(1_700_000_000_000);
    const step = totpStep(now);
    for (const delta of [-1, 0, 1]) {
      expect(verifyTotp(SECRET, hotp(SECRET, step + delta), now, null)).toBe(step + delta);
    }
    for (const delta of [-2, 2]) expect(verifyTotp(SECRET, hotp(SECRET, step + delta), now, null)).toBeNull();
  });

  it('un código ya usado (o anterior al último aceptado) no vale otra vez', () => {
    const now = new Date(1_700_000_000_000);
    const step = totpStep(now);
    const code = hotp(SECRET, step);
    expect(verifyTotp(SECRET, code, now, null)).toBe(step);
    expect(verifyTotp(SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(SECRET, hotp(SECRET, step - 1), now, step)).toBeNull();
  });

  it('formatos inválidos se rechazan sin calcular', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 345']) {
      expect(verifyTotp(SECRET, bad, new Date(), null)).toBeNull();
    }
  });

  it('URI otpauth para las apps de autenticación', () => {
    expect(otpauthUri(SECRET, 'ana@yebo.pe')).toBe(
      'otpauth://totp/YEBO%20Admin:ana%40yebo.pe?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=YEBO+Admin&algorithm=SHA1&digits=6&period=30',
    );
  });
});
