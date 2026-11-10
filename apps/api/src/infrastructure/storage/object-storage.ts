import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env';

/**
 * Almacenamiento de objetos (Fase 5.2; F5-Q2). Interfaz mínima: guardar, leer y borrar por clave. Implementación S3
 * (Garage en desarrollo; el S3 del proveedor en producción, D12). Los objetos son PRIVADOS en el bucket: la API decide
 * qué se sirve y a quién (no se publican URL del almacenamiento).
 */
export abstract class ObjectStorage {
  abstract readonly enabled: boolean;
  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** `null` si no existe. */
  abstract get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  abstract delete(key: string): Promise<void>;
}

const DISABLED = () =>
  new AppError('SERVICE_UNAVAILABLE', 'El almacenamiento de archivos no está configurado', 503);

@Injectable()
export class S3ObjectStorage extends ObjectStorage implements OnModuleDestroy {
  private readonly logger = new Logger(S3ObjectStorage.name);
  private readonly client: S3Client | null;
  readonly enabled: boolean;
  private readonly bucket: string;

  constructor(@Inject(ENV) env: Env) {
    super();
    this.bucket = env.S3_BUCKET;
    this.enabled = Boolean(env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
    this.client = this.enabled
      ? new S3Client({
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION,
          // Garage y la mayoría de servicios compatibles: rutas de estilo /bucket/clave.
          forcePathStyle: true,
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
            secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
          },
          maxAttempts: 2,
        })
      : null;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (!this.client) throw DISABLED();
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    if (!this.client) throw DISABLED();
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      return bytes
        ? { body: Buffer.from(bytes), contentType: res.ContentType ?? 'application/octet-stream' }
        : null;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.client) throw DISABLED();
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      this.logger.warn({ err: error, key }, 'No se pudo borrar el objeto (queda huérfano en el bucket)');
    }
  }

  onModuleDestroy(): void {
    this.client?.destroy();
  }
}
