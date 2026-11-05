import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACTED_PATHS } from './pino-options';

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' } }, stream);
  return { logger, lines };
}

describe('redacción de logs', () => {
  it('nunca escribe PIN, contraseñas, tokens ni cabeceras de autenticación', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        body: { pin: '0042', password: 'secreta', refreshToken: 'rt' },
        shipment: { delivery: { pin: '1234' } },
        req: { headers: { authorization: 'Bearer x', cookie: 'yebo_at=1' } },
        cfg: { apiKey: 'k', credentials: { user: 'u' } },
      },
      'evento',
    );
    const output = lines.join('');
    for (const leaked of ['0042', '1234', 'secreta', 'Bearer x', 'yebo_at=1', '"k"', '"rt"']) {
      expect(output).not.toContain(leaked);
    }
    expect(output).toContain('[REDACTED]');
  });
});
