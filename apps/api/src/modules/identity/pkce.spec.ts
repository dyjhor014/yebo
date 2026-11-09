import {
  CODE_VERIFIER_FORMAT,
  codeChallengeS256,
  newCodeVerifier,
  newOpaqueToken,
  safeEqual,
  verifyCodeChallenge,
} from './pkce';

describe('PKCE S256 (RFC 7636)', () => {
  it('vector de prueba del Apéndice B de RFC 7636', () => {
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('verifier de 43 caracteres y códigos opacos de 256 bits', () => {
    expect(newCodeVerifier()).toMatch(CODE_VERIFIER_FORMAT);
    expect(newCodeVerifier()).toHaveLength(43);
    expect(Buffer.from(newOpaqueToken(), 'base64url')).toHaveLength(32);
  });

  it('acepta verifiers de 43 a 128 caracteres y rechaza fuera de rango o con caracteres no permitidos', () => {
    const ok43 = 'a'.repeat(43);
    const ok128 = 'a'.repeat(128);
    expect(verifyCodeChallenge(ok43, codeChallengeS256(ok43))).toBe(true);
    expect(verifyCodeChallenge(ok128, codeChallengeS256(ok128))).toBe(true);
    for (const bad of ['a'.repeat(42), 'a'.repeat(129), `${'a'.repeat(42)}+`, `${'a'.repeat(42)} `]) {
      expect(verifyCodeChallenge(bad, codeChallengeS256(bad))).toBe(false);
    }
  });

  it('un verifier distinto no corresponde al reto', () => {
    const verifier = newCodeVerifier();
    expect(verifyCodeChallenge(newCodeVerifier(), codeChallengeS256(verifier))).toBe(false);
    expect(verifyCodeChallenge(verifier, 'corto')).toBe(false);
  });

  it('safeEqual: falso con valores ausentes o de distinta longitud', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
  });
});
