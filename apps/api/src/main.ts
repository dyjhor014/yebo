import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './common/http/configure-app';
import { parseEnv } from './config/env';
import { loadEnvFileIfPresent } from './config/load-env-file';

async function bootstrap(): Promise<void> {
  loadEnvFileIfPresent();
  const env = parseEnv(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  configureApp(app, env, { swagger: env.SWAGGER_ENABLED });
  await app.listen(env.API_PORT, env.API_HOST);
}

void bootstrap();
