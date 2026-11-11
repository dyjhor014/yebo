import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { InvalidConfigurationError, type Env } from '../../config/env';
import {
  AccessTokenService,
  MAX_ACCESS_TOKEN_LIFETIME_SECONDS,
  type AccessTokenSubject,
} from './access-token.service';
import type { Clock } from './clock';

const SUBJECT: AccessTokenSubject = {
  sub: '0190f0a0-0000-7000-8000-000000000001',
  sid: '0190f0a0-0000-7000-8000-000000000051',
  tid: '0190f0a0-0000-7000-8000-00000000a001',
  mid: '0190f0a0-0000-7000-8000-000000000061',
  ver: 3,
};

function pemB64(kind: 'private' | 'public', key = generateKeyPairSync('ed25519')): string {
  const pem =
    kind === 'private'
      ? key.privateKey.export({ type: 'pkcs8', format: 'pem' })
      : key.publicKey.export({ type: 'spki', format: 'pem' });
  return Buffer.from(pem).toString('base64');
}

class FakeClock implements Clock {
  constructor(public current = new Date('2026-11-10T15:00:00Z')) {}
  now(): Date {
    return this.current;
  }
}

function service(overrides: Partial<Env> = {}, clock = new FakeClock()): AccessTokenService {
  const env = {
    AUTH_JWT_PRIVATE_KEY: pemB64('private'),
    AUTH_JWT_KEY_ID: 'k1',
    AUTH_JWT_PREVIOUS_PUBLIC_KEYS: '[]',
    AUTH_JWT_ISSUER: 'yebo',
    AUTH_JWT_AUDIENCE: 'yebo-tenant-api',
    AUTH_ACCESS_TOKEN_TTL_SECONDS: 600,
    ...overrides,
  } as Env;
  return new AccessTokenService(env, clock);
}

const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('AccessTokenService (JWT EdDSA, security.md §1)', () => {
  it('firma un token de 10 minutos con claims mínimos y lo verifica', () => {
    const clock = new FakeClock();
    const s = service({}, clock);
    const { token, expiresAt } = s.sign(SUBJECT);
    expect(expiresAt.toISOString()).toBe('2026-11-10T15:10:00.000Z');
    const [header] = token.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'EdDSA',
      typ: 'JWT',
      kid: 'k1',
    });
    expect(s.verify(token)).toEqual({
      ...SUBJECT,
      iss: 'yebo',
      aud: 'yebo-tenant-api',
      iat: 1794322800,
      exp: 1794323400,
    });
  });

  it('rechaza un token expirado (tolerancia de 5 s) y uno emitido en el futuro', () => {
    const clock = new FakeClock();
    const s = service({}, clock);
    const { token } = s.sign(SUBJECT);
    clock.current = new Date('2026-11-10T15:10:04Z');
    expect(() => s.verify(token)).not.toThrow();
    clock.current = new Date('2026-11-10T15:10:06Z');
    expect(() => s.verify(token)).toThrow(
      expect.objectContaining({ code: 'UNAUTHENTICATED', httpStatus: 401 }),
    );
    clock.current = new Date('2026-11-10T14:59:50Z');
    expect(() => s.verify(token)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });

  it('rechaza un payload alterado (la firma no coincide)', () => {
    const s = service();
    const [h, , sig] = s.sign(SUBJECT).token.split('.');
    const forged = `${h}.${b64({ ...SUBJECT, ver: 99, iss: 'yebo', aud: 'yebo-tenant-api', iat: 1794322800, exp: 1794323400 })}.${sig}`;
    expect(() => s.verify(forged)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });

  it('rechaza alg "none", HS256 y kid desconocido aunque el resto sea válido', () => {
    const s = service();
    const [, payload, sig] = s.sign(SUBJECT).token.split('.');
    for (const header of [
      { alg: 'none', typ: 'JWT', kid: 'k1' },
      { alg: 'HS256', typ: 'JWT', kid: 'k1' },
      { alg: 'EdDSA', typ: 'JWT', kid: 'otro' },
      { alg: 'EdDSA', typ: 'JWT' },
    ]) {
      expect(() => s.verify(`${b64(header)}.${payload}.${sig}`)).toThrow(
        expect.objectContaining({ code: 'UNAUTHENTICATED' }),
      );
      expect(() => s.verify(`${b64(header)}.${payload}.`)).toThrow(
        expect.objectContaining({ code: 'UNAUTHENTICATED' }),
      );
    }
  });

  it('rechaza un token firmado con otra clave Ed25519', () => {
    const a = service();
    const b = service();
    expect(() => b.verify(a.sign(SUBJECT).token)).toThrow(
      expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    );
  });

  it('rechaza claims inesperados, de otro emisor o con formato inválido aunque estén bien firmados', () => {
    const keys = generateKeyPairSync('ed25519');
    const s = service({ AUTH_JWT_PRIVATE_KEY: pemB64('private', keys) });
    const signWith = (claims: object): string => {
      const head = b64({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
      const body = b64(claims);
      return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), keys.privateKey).toString('base64url')}`;
    };
    const base = { ...SUBJECT, iss: 'yebo', aud: 'yebo-tenant-api', iat: 1794322800, exp: 1794323400 };
    expect(s.verify(signWith(base))).toEqual(base);
    expect(() => s.verify(signWith({ ...base, admin: true }))).toThrow();
    expect(() => s.verify(signWith({ ...base, iss: 'otro' }))).toThrow();
    expect(() => s.verify(signWith({ ...base, tid: 'no-es-uuid' }))).toThrow();
    expect(() => s.verify(signWith({ ...base, ver: 0 }))).toThrow();
    expect(() => s.verify('basura')).toThrow();
    expect(() => s.verify(`${'a'.repeat(3000)}.b.c`)).toThrow();
  });

  it('acepta tokens de una clave anterior declarada (rotación) y sigue firmando con la actual', () => {
    const old = generateKeyPairSync('ed25519');
    const previous = service({ AUTH_JWT_PRIVATE_KEY: pemB64('private', old), AUTH_JWT_KEY_ID: 'k0' });
    const current = service({
      AUTH_JWT_KEY_ID: 'k1',
      AUTH_JWT_PREVIOUS_PUBLIC_KEYS: JSON.stringify([{ kid: 'k0', key: pemB64('public', old) }]),
    });
    const oldToken = previous.sign(SUBJECT).token;
    expect(current.verify(oldToken).sid).toBe(SUBJECT.sid);
    expect(current.sign(SUBJECT).token.split('.')[0]).toBe(b64({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' }));
  });

  it('la configuración inválida impide arrancar, sin revelar valores', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = Buffer.from(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    expect(() => service({ AUTH_JWT_PRIVATE_KEY: undefined })).toThrow(InvalidConfigurationError);
    expect(() => service({ AUTH_JWT_PRIVATE_KEY: 'no-es-pem' })).toThrow(/no es una clave PEM válida/);
    expect(() => service({ AUTH_JWT_PRIVATE_KEY: rsaPem })).toThrow(/debe ser una clave Ed25519/);
    expect(() => service({ AUTH_JWT_PREVIOUS_PUBLIC_KEYS: '{' })).toThrow(/JSON inválido/);
    const pub = Buffer.from(createPublicKey(rsa.privateKey).export({ type: 'spki', format: 'pem' })).toString(
      'base64',
    );
    expect(() =>
      service({ AUTH_JWT_PREVIOUS_PUBLIC_KEYS: JSON.stringify([{ kid: 'k0', key: pub }]) }),
    ).toThrow(/debe ser una clave Ed25519/);
    expect(() =>
      service({ AUTH_JWT_PREVIOUS_PUBLIC_KEYS: JSON.stringify([{ kid: 'k1', key: pemB64('public') }]) }),
    ).toThrow(/kid repetido/);
  });

  it('exige la audiencia de la API de empresas: otra audiencia o sin aud → rechazado', () => {
    const keys = generateKeyPairSync('ed25519');
    const s = service({ AUTH_JWT_PRIVATE_KEY: pemB64('private', keys) });
    const forAudience = service({
      AUTH_JWT_PRIVATE_KEY: pemB64('private', keys),
      AUTH_JWT_AUDIENCE: 'yebo-platform-api',
    });
    expect(() => s.verify(forAudience.sign(SUBJECT).token)).toThrow(
      expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    );
    const head = b64({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
    const body = b64({ ...SUBJECT, iss: 'yebo', iat: 1794322800, exp: 1794323400 });
    const token = `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), keys.privateKey).toString('base64url')}`;
    expect(() => s.verify(token)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });

  it(`rechaza tokens con una vida mayor de ${MAX_ACCESS_TOKEN_LIFETIME_SECONDS} s aunque estén bien firmados`, () => {
    const keys = generateKeyPairSync('ed25519');
    const s = service({ AUTH_JWT_PRIVATE_KEY: pemB64('private', keys) });
    const head = b64({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
    const forge = (exp: number): string => {
      const body = b64({ ...SUBJECT, iss: 'yebo', aud: 'yebo-tenant-api', iat: 1794322800, exp });
      return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), keys.privateKey).toString('base64url')}`;
    };
    expect(s.verify(forge(1794322800 + 900)).exp).toBe(1794322800 + 900);
    expect(() => s.verify(forge(1794322800 + 901))).toThrow(
      expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    );
    expect(() => s.verify(forge(1794322800 + 86400))).toThrow(
      expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    );
  });

  it('la vida configurada nunca supera el máximo aceptado', () => {
    const clock = new FakeClock();
    const s = service({ AUTH_ACCESS_TOKEN_TTL_SECONDS: 5000 }, clock);
    const { expiresAt } = s.sign(SUBJECT);
    expect((expiresAt.getTime() - clock.now().getTime()) / 1000).toBe(MAX_ACCESS_TOKEN_LIFETIME_SECONDS);
  });
});
