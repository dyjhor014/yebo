import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { parseEnv } from '../../src/config/env';
import { buildQueueConnection } from '../../src/infrastructure/queue/queue-connection';

describe('BullMQ sobre el Redis configurado', () => {
  it('encola, procesa y completa un trabajo con reintentos configurados', async () => {
    const env = parseEnv(process.env);
    const connection = buildQueueConnection(env);
    const name = `test-${randomUUID()}`;
    const prefix = `${env.BULLMQ_PREFIX}-test`;
    const queue = new Queue(name, { connection, prefix });
    const events = new QueueEvents(name, { connection, prefix });
    let attempts = 0;
    const worker = new Worker(
      name,
      async (job) => {
        attempts++;
        if (attempts === 1) throw new Error('fallo transitorio simulado en la prueba');
        return { echoed: job.data.value };
      },
      { connection, prefix },
    );
    try {
      await events.waitUntilReady();
      const job = await queue.add(
        'echo',
        { value: 42 },
        { attempts: 3, backoff: { type: 'fixed', delay: 50 }, jobId: 'evento-idempotente-1' },
      );
      // Un segundo add con el mismo jobId no crea un trabajo duplicado (base del outbox, ADR-008).
      const duplicate = await queue.add('echo', { value: 99 }, { jobId: 'evento-idempotente-1' });
      expect(duplicate.id).toBe(job.id);
      await expect(job.waitUntilFinished(events, 10_000)).resolves.toEqual({ echoed: 42 });
      expect(attempts).toBe(2);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await Promise.all([queue.close(), events.close()]);
    }
  });
});
