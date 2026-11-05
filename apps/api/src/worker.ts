import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './common/http/configure-app';
import { parseEnv } from './config/env';
import { loadEnvFileIfPresent } from './config/load-env-file';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  loadEnvFileIfPresent();
  const env = parseEnv(process.env);
  const app = await NestFactory.create<NestExpressApplication>(WorkerModule, { bufferLogs: true });
  configureApp(app, env, { swagger: false });
  // Solo health interno: escucha en una interfaz privada.
  await app.listen(env.WORKER_HEALTH_PORT, env.WORKER_HEALTH_HOST);
}

void bootstrap();
