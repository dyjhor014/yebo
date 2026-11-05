import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import type { Env } from '../../config/env';
import { requestIdMiddleware } from './request-id.middleware';

export const BODY_LIMIT = '1mb';

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * Configuración HTTP común a main.ts, worker.ts y las pruebas e2e.
 * Debe llamarse antes de app.init()/listen() para que el request id preceda al resto de middlewares.
 */
export function configureApp(app: NestExpressApplication, env: Env, options: { swagger: boolean }): void {
  app.use(requestIdMiddleware);
  app.use(helmet());
  app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: false });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();
  // CORS deshabilitado: la web consume la API en el mismo origen vía Nginx (security §3).

  if (options.swagger) {
    const config = new DocumentBuilder()
      .setTitle('YEBO API')
      .setDescription('API REST versionada de la plataforma YEBO')
      .setVersion(env.APP_VERSION)
      .build();
    const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
    SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs/openapi.json' });
  }
}
