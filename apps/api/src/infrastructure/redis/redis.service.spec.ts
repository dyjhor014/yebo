import type { Env } from '../../config/env';
import { RedisService } from './redis.service';

// Puerto sin servicio: con lazyConnect la prueba nunca abre una conexión.
const env = { REDIS_HOST: '127.0.0.1', REDIS_PORT: 1, REDIS_PASSWORD: 'x' } as unknown as Env;

describe('RedisService · apagado', () => {
  it('sin conexión abierta (wait): desconecta sin enviar QUIT ni conectar', async () => {
    const service = new RedisService(env);
    const quit = jest.spyOn(service.client, 'quit');
    const connect = jest.spyOn(service.client, 'connect');
    expect(service.client.status).toBe('wait');

    await service.onModuleDestroy();

    expect(quit).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(service.client.status).toBe('end');
  });

  it('con la conexión lista: cierra de forma ordenada con QUIT', async () => {
    const service = new RedisService(env);
    Object.defineProperty(service.client, 'status', { value: 'ready', configurable: true });
    const quit = jest.spyOn(service.client, 'quit').mockResolvedValue('OK');

    await service.onModuleDestroy();

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('ya cerrada (end): no hace nada', async () => {
    const service = new RedisService(env);
    service.client.disconnect();
    const quit = jest.spyOn(service.client, 'quit');
    const disconnect = jest.spyOn(service.client, 'disconnect');

    await service.onModuleDestroy();

    expect(quit).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });
});
