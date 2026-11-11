import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { SiteAsset, SiteAssetKind } from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import sharp from 'sharp';
import { AppError } from '../../common/errors/app-error';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { ObjectStorage } from '../../infrastructure/storage/object-storage';

/**
 * Logos e imágenes de portada del sitio (Fase 5.2). Cada imagen se valida por su CONTENIDO (no por el nombre ni la
 * cabecera que declara el cliente) y se recodifica: así se eliminan los metadatos (EXIF, ubicación GPS de una foto de
 * móvil) y nunca se guarda ni se sirve el archivo original. Del logo se genera además un favicon de 64 × 64.
 */
export const SITE_ASSET_MAX_INPUT_BYTES = 5 * 1024 * 1024;
const KIND = { logo: 'SITE_LOGO', hero: 'SITE_HERO' } as const;
const RULES = {
  logo: { minWidth: 64, minHeight: 64, maxWidth: 1024, maxHeight: 1024, format: 'png' as const },
  hero: { minWidth: 1200, minHeight: 600, maxWidth: 2400, maxHeight: 1600, format: 'webp' as const },
};
const MIME = { png: 'image/png', webp: 'image/webp' } as const;
const ACCEPTED = new Set(['png', 'jpeg', 'webp']);
const MAX_PIXELS = 50_000_000;

export const faviconKey = (storageKey: string) => `${storageKey}.favicon.png`;

type AssetRow = {
  id: string;
  kind: 'SITE_LOGO' | 'SITE_HERO';
  mime: string;
  sizeBytes: number;
  width: number;
  height: number;
  createdAt: Date;
};

@Injectable()
export class SiteAssetsService {
  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly storage: ObjectStorage,
  ) {}

  async upload(kind: SiteAssetKind, input: unknown): Promise<SiteAsset> {
    if (!this.storage.enabled) {
      throw new AppError('SERVICE_UNAVAILABLE', 'El almacenamiento de archivos no está configurado', 503);
    }
    if (!Buffer.isBuffer(input) || input.length === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Envía la imagen como PNG, JPEG o WebP en el cuerpo de la petición',
        400,
      );
    }
    const tenantId = this.tenantId();
    const actor = this.actor();
    const rules = RULES[kind];
    // Solo la cabecera (no decodifica los píxeles): sin límite aquí para poder dar el motivo exacto más abajo.
    const meta = await sharp(input, { failOn: 'error', limitInputPixels: false })
      .metadata()
      .catch(() => {
        throw new AppError('VALIDATION_FAILED', 'El archivo no es una imagen PNG, JPEG o WebP válida', 400);
      });
    if (!meta.format || !ACCEPTED.has(meta.format) || !meta.width || !meta.height) {
      throw new AppError('VALIDATION_FAILED', 'El archivo no es una imagen PNG, JPEG o WebP válida', 400);
    }
    // Bomba de descompresión: un archivo pequeño que declara millones de píxeles se rechaza antes de decodificarlo.
    if (meta.width * meta.height > MAX_PIXELS) {
      throw new AppError('VALIDATION_FAILED', 'La imagen tiene demasiados píxeles (máximo 50 millones)', 400);
    }
    // Dimensiones ya orientadas (una foto vertical de móvil trae la rotación en EXIF).
    const rotated = (meta.orientation ?? 1) >= 5;
    const width = rotated ? meta.height : meta.width;
    const height = rotated ? meta.width : meta.height;
    if (width < rules.minWidth || height < rules.minHeight) {
      throw new AppError(
        'VALIDATION_FAILED',
        `La imagen es muy pequeña (${width} × ${height}); mínimo ${rules.minWidth} × ${rules.minHeight} píxeles`,
        400,
      );
    }
    // Recodificar: aplica la orientación, reduce si hace falta y descarta todos los metadatos.
    const pipeline = sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS })
      .rotate()
      .resize({ width: rules.maxWidth, height: rules.maxHeight, fit: 'inside', withoutEnlargement: true });
    const encoded =
      rules.format === 'png' ? pipeline.png({ compressionLevel: 9 }) : pipeline.webp({ quality: 82 });
    // Un archivo con la cabecera bien pero los datos dañados falla al decodificar: es un 400, no un 500.
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true }).catch(() => {
      throw new AppError('VALIDATION_FAILED', 'La imagen está dañada o no se puede leer', 400);
    });

    const id = randomUUID();
    const storageKey = `tenants/${tenantId}/site/${id}.${rules.format}`;
    await this.storage.put(storageKey, data, MIME[rules.format]);
    if (kind === 'logo') {
      const favicon = await sharp(data)
        .resize({ width: 64, height: 64, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      await this.storage.put(faviconKey(storageKey), favicon, 'image/png');
    }
    try {
      const row = await this.db.transaction((tx) =>
        tx.fileAsset.create({
          data: {
            id,
            tenantId,
            kind: KIND[kind],
            visibility: 'PUBLIC',
            status: 'READY',
            storageKey,
            mime: MIME[rules.format],
            sizeBytes: data.length,
            width: info.width,
            height: info.height,
            checksumSha256: createHash('sha256').update(data).digest(),
            uploadedByKind: actor.kind,
            uploadedById: actor.id,
          },
          select: SELECT,
        }),
      );
      return toAsset(row);
    } catch (error) {
      // Sin fila no hay referencia posible: se retiran los objetos para no dejar huérfanos.
      await this.storage.delete(storageKey);
      if (kind === 'logo') await this.storage.delete(faviconKey(storageKey));
      throw error;
    }
  }

  async list(): Promise<SiteAsset[]> {
    const rows = await this.db.transaction((tx) =>
      tx.fileAsset.findMany({ where: { status: 'READY' }, select: SELECT, orderBy: { createdAt: 'desc' } }),
    );
    return rows.map(toAsset);
  }

  /**
   * Retira un archivo que ya no se usa (Fase 5.4): pasa a DELETED, deja de servirse y de poder referenciarse, y se
   * borran sus objetos. No se retira si lo usa el borrador o la versión publicada (409): primero hay que quitarlo y
   * guardar. Una versión archivada que lo use ya no se podrá restaurar (la API lo explica al intentarlo).
   */
  async retire(assetId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(assetId)) throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
    const keys = await this.db.transaction(async (tx) => {
      // Mismo candado que las escrituras del sitio: nadie guarda una referencia a este archivo mientras se retira.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`site:${this.tenantId()}`}, 0))`;
      const row = await tx.fileAsset.findFirst({
        where: { id: assetId, status: 'READY' },
        select: { kind: true, storageKey: true },
      });
      if (!row) throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
      const live = await tx.siteVersion.findMany({
        where: { status: { in: ['DRAFT', 'PUBLISHED'] } },
        select: { config: true },
      });
      if (live.some((v) => references(v.config, assetId))) {
        throw new AppError(
          'CONFLICT',
          'Este archivo está en uso en el borrador o en el sitio publicado: quítalo y guarda antes de retirarlo',
          409,
        );
      }
      await tx.fileAsset.update({ where: { id: assetId }, data: { status: 'DELETED' } });
      return row.kind === 'SITE_LOGO' ? [row.storageKey, faviconKey(row.storageKey)] : [row.storageKey];
    });
    // Ya no se sirve (DELETED): si borrar el objeto falla, queda un huérfano inofensivo y no se repite el error.
    for (const key of keys) await this.storage.delete(key).catch(() => undefined);
  }

  /** Para el portal público: un archivo PUBLIC y READY de la empresa del host (RLS), o null. */
  async publicObject(assetId: string, variant: 'original' | 'favicon') {
    if (!/^[0-9a-f-]{36}$/.test(assetId)) return null;
    const row = await this.db.transaction((tx) =>
      tx.fileAsset.findFirst({
        where: { id: assetId, status: 'READY', visibility: 'PUBLIC' },
        select: { kind: true, storageKey: true, mime: true, checksumSha256: true },
      }),
    );
    if (!row || (variant === 'favicon' && row.kind !== 'SITE_LOGO')) return null;
    const key = variant === 'favicon' ? faviconKey(row.storageKey) : row.storageKey;
    const object = await this.storage.get(key);
    if (!object) return null;
    const etag = `"${Buffer.from(row.checksumSha256).toString('hex').slice(0, 32)}${variant === 'favicon' ? '-f' : ''}"`;
    return { body: object.body, contentType: variant === 'favicon' ? 'image/png' : row.mime, etag };
  }

  private tenantId(): string {
    const id = this.cls.get('tenantId');
    if (!id) throw new Error('SiteAssetsService requiere el tenant del host');
    return id;
  }

  private actor(): { kind: 'MEMBERSHIP' | 'PLATFORM_USER'; id: string } {
    const principal = this.cls.get('principal');
    if (principal) return { kind: 'MEMBERSHIP', id: principal.membershipId };
    const support = this.cls.get('supportPrincipal');
    if (support) return { kind: 'PLATFORM_USER', id: support.platformUserId };
    throw new Error('SiteAssetsService requiere una sesión verificada');
  }
}

/** El JSON guardado referencia el archivo como logo o como imagen de portada (sin validar el resto). */
function references(config: unknown, assetId: string): boolean {
  if (typeof config !== 'object' || config === null) return false;
  const c = config as { logoAssetId?: unknown; hero?: { imageAssetId?: unknown } };
  return c.logoAssetId === assetId || c.hero?.imageAssetId === assetId;
}

const SELECT = {
  id: true,
  kind: true,
  mime: true,
  sizeBytes: true,
  width: true,
  height: true,
  createdAt: true,
} as const;

function toAsset(row: AssetRow): SiteAsset {
  return {
    id: row.id,
    kind: row.kind === 'SITE_LOGO' ? 'logo' : 'hero',
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt.toISOString(),
    url: `/api/v1/public/assets/${row.id}`,
  };
}
