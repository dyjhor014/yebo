import type { Response } from 'express';
import { InvalidConfigurationError, type Env } from '../../../config/env';
import { CookieSigner } from './cookie-signer';
import { setCookie } from './cookies';

const signer = new CookieSigner({ AUTH_COOKIE_SECRET: 's'.repeat(40) } as Env);

describe('CookieSigner', () => {
  it('firma y verifica; la firma no sirve para otro propósito ni con otra clave', () => {
    const signed = signer.sign('hub-session', 'valor');
    expect(signer.verify('hub-session', signed)).toBe('valor');
    expect(signer.verify('auth-request', signed)).toBeNull();
    expect(
      new CookieSigner({ AUTH_COOKIE_SECRET: 't'.repeat(40) } as Env).verify('hub-session', signed),
    ).toBeNull();
  });

  it('rechaza valores alterados, sin firma o ausentes', () => {
    const signed = signer.sign('hub-session', 'valor');
    expect(signer.verify('hub-session', signed.replace('valor', 'otro'))).toBeNull();
    expect(signer.verify('hub-session', 'valor')).toBeNull();
    expect(signer.verify('hub-session', undefined)).toBeNull();
  });

  it('sin AUTH_COOKIE_SECRET el módulo no arranca', () => {
    expect(() => new CookieSigner({} as Env)).toThrow(InvalidConfigurationError);
  });
});

describe('setCookie', () => {
  const capture = () => {
    const headers: string[] = [];
    const res = { append: (_name: string, value: string) => headers.push(value) } as unknown as Response;
    return { res, headers };
  };

  it('siempre Secure; las __Host- exigen Path=/', () => {
    const { res, headers } = capture();
    setCookie(res, '__Host-x', 'v', { maxAgeSeconds: 10, httpOnly: true, sameSite: 'Lax' });
    expect(headers[0]).toBe('__Host-x=v; Max-Age=10; Path=/; Secure; SameSite=Lax; HttpOnly');
    expect(() =>
      setCookie(res, '__Host-x', 'v', { maxAgeSeconds: 10, httpOnly: true, sameSite: 'Lax', path: '/api' }),
    ).toThrow();
  });
});
