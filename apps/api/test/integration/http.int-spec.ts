import type { NestExpressApplication } from '@nestjs/platform-express';
import { ErrorResponseSchema, HealthResponseSchema } from '@yebo/contracts';
import request from 'supertest';
import { createTestApp } from '../support/create-test-app';

describe('API HTTP (Nest real + PostgreSQL + Redis)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health/live responde sin consultar dependencias', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200, { status: 'ok' });
  });

  it('GET /api/v1/health/ready verifica ambos roles de PostgreSQL y Redis', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    const body = HealthResponseSchema.parse(res.body);
    expect(body.status).toBe('ok');
    expect(Object.keys(body.checks).sort()).toEqual(['databaseApp', 'databasePlatform', 'redis']);
    expect(Object.values(body.checks).every((c) => c.status === 'up')).toBe(true);
  });

  it('propaga x-request-id como traceId en respuestas de error con el formato único', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/no-existe')
      .set('x-request-id', 'traza-de-prueba-0001')
      .expect(404);
    expect(res.headers['x-request-id']).toBe('traza-de-prueba-0001');
    expect(ErrorResponseSchema.parse(res.body)).toEqual({
      error: { code: 'NOT_FOUND', message: 'Recurso no encontrado', traceId: 'traza-de-prueba-0001' },
    });
  });

  it('ignora x-request-id inseguros y genera uno nuevo', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/no-existe').set('x-request-id', '<script>');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rechaza cuerpos de más de 1 MB con 413 y el formato de error', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/health/live')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ data: 'x'.repeat(1_100_000) }))
      .expect(413);
    expect(ErrorResponseSchema.parse(res.body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('JSON malformado → 400 BAD_REQUEST sin detalles internos', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/health/live')
      .set('content-type', 'application/json')
      .send('{malformado')
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(res.body)).not.toMatch(/Unexpected token|SyntaxError/);
  });

  it('aplica cabeceras de seguridad (Helmet) y no expone X-Powered-By', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('publica el documento OpenAPI generado desde los contratos Zod', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs/openapi.json').expect(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/api/v1/health/live', '/api/v1/health/ready']),
    );
    expect(res.body.components.schemas.HealthResponseDto).toBeDefined();
  });
});

describe('API HTTP con una dependencia caída', () => {
  it('readiness responde 503 y marca Redis como "down" sin filtrar detalles de conexión', async () => {
    const app = await createTestApp({ REDIS_PORT: '6399' });
    try {
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
      const body = HealthResponseSchema.parse(res.body);
      expect(body.status).toBe('error');
      expect(body.checks.redis?.status).toBe('down');
      expect(body.checks.databaseApp?.status).toBe('up');
      expect(JSON.stringify(body)).not.toMatch(/6399|127\.0\.0\.1|ECONNREFUSED/);
    } finally {
      await app.close();
    }
  });
});
