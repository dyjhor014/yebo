import { AppError } from '../../common/errors/app-error';
import type { Env } from '../../config/env';
import { S3ObjectStorage } from './object-storage';

const env = (overrides: Partial<Env>) =>
  ({ S3_REGION: 'garage', S3_BUCKET: 'yebo-assets', ...overrides }) as Env;

describe('S3ObjectStorage', () => {
  it('sin endpoint o sin claves queda desactivado y cada operación responde 503 (no rompe el arranque)', async () => {
    for (const partial of [
      {},
      { S3_ENDPOINT: 'http://127.0.0.1:3900', S3_ACCESS_KEY_ID: 'GK00' },
      { S3_ACCESS_KEY_ID: 'GK00', S3_SECRET_ACCESS_KEY: 'x'.repeat(64) },
    ]) {
      const storage = new S3ObjectStorage(env(partial));
      expect(storage.enabled).toBe(false);
      for (const op of [
        () => storage.put('k', Buffer.from('x'), 'image/png'),
        () => storage.get('k'),
        () => storage.delete('k'),
      ]) {
        await expect(op()).rejects.toMatchObject({ httpStatus: 503, code: 'SERVICE_UNAVAILABLE' });
        await expect(op()).rejects.toBeInstanceOf(AppError);
      }
    }
  });

  it('con endpoint y claves queda activado', () => {
    const storage = new S3ObjectStorage(
      env({
        S3_ENDPOINT: 'http://127.0.0.1:3900',
        S3_ACCESS_KEY_ID: 'GK00',
        S3_SECRET_ACCESS_KEY: 'x'.repeat(64),
      }),
    );
    expect(storage.enabled).toBe(true);
    storage.onModuleDestroy();
  });
});
