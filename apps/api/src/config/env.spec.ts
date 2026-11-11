import { InvalidConfigurationError, parseEnv } from './env';

const valid = {
  PG_HOST: 'localhost',
  PG_PORT: '5433',
  PG_DATABASE: 'yebo_dev',
  PG_APP_USER: 'yebo_app',
  PG_APP_PASSWORD: 'a'.repeat(32),
  PG_PLATFORM_USER: 'yebo_platform',
  PG_PLATFORM_PASSWORD: 'b'.repeat(32),
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6380',
  REDIS_PASSWORD: 'c'.repeat(32),
};

describe('parseEnv', () => {
  it('aplica valores por defecto seguros', () => {
    const env = parseEnv(valid);
    expect(env.API_PORT).toBe(4100);
    expect(env.SWAGGER_ENABLED).toBe(false);
    expect(env.LOG_PRETTY).toBe(false);
    expect(env.PG_PORT).toBe(5433);
  });

  it('rechaza secretos débiles sin revelar su valor', () => {
    try {
      parseEnv({ ...valid, PG_APP_PASSWORD: 'corta123' });
      throw new Error('debía fallar');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConfigurationError);
      expect((error as Error).message).toContain('PG_APP_PASSWORD');
      expect((error as Error).message).not.toContain('corta123');
    }
  });

  it('exige roles distintos para aplicación y plataforma (ADR-003)', () => {
    expect(() => parseEnv({ ...valid, PG_PLATFORM_USER: 'yebo_app' })).toThrow(/rol de plataforma/);
  });

  it('exige que el rol de identidad sea distinto de los de aplicación y plataforma', () => {
    expect(() => parseEnv({ ...valid, PG_IDENTITY_USER: 'yebo_app' })).toThrow(/PG_IDENTITY_USER/);
    expect(() => parseEnv({ ...valid, PG_IDENTITY_USER: 'yebo_platform' })).toThrow(/PG_IDENTITY_USER/);
    expect(parseEnv(valid).PG_IDENTITY_USER).toBe('yebo_identity');
  });

  it.each(['PG_APP_USER', 'PG_PLATFORM_USER', 'PG_IDENTITY_USER', 'PG_OWNER_USER'])(
    'rechaza un rol que salta RLS en %s (ADR-034)',
    (key) => {
      expect(() => parseEnv({ ...valid, [key]: 'yebo_test_BYPASS' })).toThrow(InvalidConfigurationError);
    },
  );

  it('prohíbe logs con formato pretty en producción', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production', LOG_PRETTY: 'true' })).toThrow(/LOG_PRETTY/);
  });
});
