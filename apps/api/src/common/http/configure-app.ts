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
  // La API nunca se muestra en un marco (frame-ancestors 'none') ni filtra la URL de origen (no-referrer):
  // protege el hub de cuentas y el canje del código (identity-and-sessions §5).
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { 'frame-ancestors': ["'none'"] } },
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: false });
  // Fase 5.2: imágenes del sitio en el cuerpo, sin multipart (POST /site/assets). El tipo real lo comprueba sharp.
  // Archivos binarios (5.2: imágenes del sitio; 6.2: documentos de vehículos, también PDF). El límite general es el
  // mayor (10 MB); cada servicio impone el suyo (el sitio, 5 MB) y comprueba el tipo por el contenido.
  app.useBodyParser('raw', {
    type: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
    limit: '10mb',
  });
  // 7.1: trazas de rutas (GPX o KML) en el cuerpo, como texto sin interpretar: las lee el importador, que no
  // resuelve entidades ni referencias externas (routes/trace-import.ts). Su propio límite es de 5 MB.
  app.useBodyParser('raw', {
    type: ['application/gpx+xml', 'application/vnd.google-earth.kml+xml', 'application/xml', 'text/xml'],
    limit: '6mb',
  });
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
