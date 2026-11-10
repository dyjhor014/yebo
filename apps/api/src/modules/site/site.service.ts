import { Injectable, Logger } from '@nestjs/common';
import {
  SITE_MAX_BYTES,
  SITE_SCHEMA_VERSION,
  SiteConfigSchema,
  defaultSiteConfig,
  effectiveSiteConfig,
  siteConfigBytes,
  themeContrastProblems,
  type PublicSiteResponse,
  type SiteConfig,
  type SiteEditorResponse,
  type SiteVersion,
  type SiteVersionsResponse,
} from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../common/errors/app-error';
import type { Prisma } from '../../generated/prisma/client';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { TenantDbService } from '../../infrastructure/database/tenant-db.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { EffectiveModulesService } from '../access/effective-modules.service';
import { Clock } from '../identity/clock';

/**
 * Caché del sitio público por empresa. Se invalida al publicar o restaurar; los cambios de plan llegan en ≤ 60 s.
 * Riesgo aceptado (revisión de la 5.1): una lectura que empezó antes de publicar puede volver a escribir la versión
 * anterior después de la invalidación; el portal la mostraría como mucho 60 s.
 */
const PUBLIC_CACHE_TTL_SECONDS = 60;
const cacheKey = (tenantId: string) => `site:pub:v1:${tenantId}`;

type Tx = Parameters<Parameters<TenantDbService['transaction']>[0]>[0];
type Row = {
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  config: Prisma.JsonValue;
  updatedAt: Date;
  publishedAt: Date | null;
};
const SELECT = { version: true, status: true, config: true, updatedAt: true, publishedAt: true } as const;

/**
 * Sitio público de la empresa (Fase 5.1; F5-Q1 a F5-Q6). Un borrador editable y una versión publicada; publicar y
 * restaurar son atómicos (una transacción, serializada por empresa) y nunca se borra una versión. El tema se valida
 * por contraste (AA) en el servidor. Sin el módulo WHITE_LABEL se publica lo básico (effectiveSiteConfig).
 */
@Injectable()
export class SiteService {
  private readonly logger = new Logger(SiteService.name);

  constructor(
    private readonly db: TenantDbService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly modules: EffectiveModulesService,
    private readonly redis: RedisService,
    private readonly clock: Clock,
  ) {}

  async editor(): Promise<SiteEditorResponse> {
    const whiteLabel = (await this.modules.current()).has('WHITE_LABEL');
    const rows = await this.db.transaction((tx) =>
      tx.siteVersion.findMany({ where: { status: { in: ['DRAFT', 'PUBLISHED'] } }, select: SELECT }),
    );
    const of = (status: Row['status']) => {
      const row = rows.find((r) => r.status === status);
      return row ? toVersion(row) : null;
    };
    return { whiteLabel, draft: of('DRAFT'), published: of('PUBLISHED') };
  }

  /** Crea o reemplaza el borrador. La validación de forma ya la hizo el DTO; aquí, las reglas de negocio. */
  async saveDraft(config: SiteConfig): Promise<SiteEditorResponse> {
    assertPublishable(config);
    await this.db.transaction(async (tx) => {
      await this.lock(tx);
      await assertAssets(tx, config);
      const draft = await tx.siteVersion.findFirst({ where: { status: 'DRAFT' }, select: { id: true } });
      const json = config as unknown as Prisma.InputJsonValue;
      if (draft) {
        await tx.siteVersion.update({
          where: { id: draft.id },
          data: { config: json, schemaVersion: SITE_SCHEMA_VERSION },
        });
      } else {
        await tx.siteVersion.create({
          data: {
            tenantId: this.tenantId(),
            version: await nextVersion(tx),
            status: 'DRAFT',
            liveSlot: 'DRAFT',
            schemaVersion: SITE_SCHEMA_VERSION,
            config: json,
          },
        });
      }
    });
    return this.editor();
  }

  /** El borrador pasa a publicado y la publicada anterior a archivada, en la misma transacción. */
  async publish(): Promise<SiteEditorResponse> {
    const actor = this.actor();
    await this.db.transaction(async (tx) => {
      await this.lock(tx);
      const draft = await tx.siteVersion.findFirst({
        where: { status: 'DRAFT' },
        select: { id: true, config: true },
      });
      if (!draft) throw new AppError('CONFLICT', 'No hay un borrador que publicar', 409);
      const config = parseStored(draft.config);
      assertPublishable(config);
      await assertAssets(tx, config);
      await archivePublished(tx);
      await tx.siteVersion.update({
        where: { id: draft.id },
        data: {
          status: 'PUBLISHED',
          liveSlot: 'PUBLISHED',
          publishedAt: this.clock.now(),
          publishedByKind: actor.kind,
          publishedById: actor.id,
        },
      });
    });
    await this.invalidate();
    return this.editor();
  }

  /** Historial sin el contenido (no se lee ni se valida el JSON de cada versión). */
  async versions(): Promise<SiteVersionsResponse> {
    const rows = await this.db.transaction((tx) =>
      tx.siteVersion.findMany({
        select: { version: true, status: true, updatedAt: true, publishedAt: true },
        orderBy: { version: 'desc' },
      }),
    );
    return {
      versions: rows.map((r) => ({
        version: r.version,
        status: r.status,
        updatedAt: r.updatedAt.toISOString(),
        publishedAt: r.publishedAt?.toISOString() ?? null,
      })),
    };
  }

  /** Vuelve a publicar una versión anterior como versión NUEVA (la historia no se reescribe). El borrador no cambia. */
  async restore(version: number): Promise<SiteEditorResponse> {
    if (!Number.isInteger(version) || version < 1)
      throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
    const actor = this.actor();
    await this.db.transaction(async (tx) => {
      await this.lock(tx);
      const source = await tx.siteVersion.findFirst({
        where: { version },
        select: { status: true, config: true },
      });
      if (!source) throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
      if (source.status !== 'ARCHIVED') {
        throw new AppError('CONFLICT', 'Solo se restaura una versión archivada', 409);
      }
      const config = parseStored(source.config);
      assertPublishable(config);
      await assertAssets(tx, config);
      await archivePublished(tx);
      await tx.siteVersion.create({
        data: {
          tenantId: this.tenantId(),
          version: await nextVersion(tx),
          status: 'PUBLISHED',
          liveSlot: 'PUBLISHED',
          schemaVersion: SITE_SCHEMA_VERSION,
          config: config as unknown as Prisma.InputJsonValue,
          publishedAt: this.clock.now(),
          publishedByKind: actor.kind,
          publishedById: actor.id,
        },
      });
    });
    await this.invalidate();
    return this.editor();
  }

  /** Portal público: la versión publicada con lo que permite el plan, y los servicios que opera la empresa. */
  async publicSite(tenant: { id: string; slug: string; tradeName: string }): Promise<PublicSiteResponse> {
    const cached = await this.cacheGet(tenant.id);
    if (cached) return cached;
    const whiteLabel = (await this.modules.current()).has('WHITE_LABEL');
    const [published, services] = await this.db.transaction(async (tx) => [
      await tx.siteVersion.findFirst({
        where: { status: 'PUBLISHED' },
        select: { version: true, config: true },
      }),
      await tx.tenantService.findMany({
        where: { enabled: true },
        select: { modality: true, service: true },
        orderBy: [{ modality: 'asc' }, { service: 'asc' }],
      }),
    ]);
    // Una versión publicada que ya no valida (esquema endurecido o edición manual) no tumba el portal: se sirve la
    // configuración por defecto y queda registrado para corregirla.
    const stored = published ? SiteConfigSchema.safeParse(published.config) : null;
    if (stored && !stored.success) {
      this.logger.error(
        { tenantId: tenant.id, version: published?.version, issues: stored.error.issues.slice(0, 5) },
        'La versión publicada del sitio no supera el esquema; se sirve la configuración por defecto',
      );
    }
    const config = stored?.success ? stored.data : defaultSiteConfig(tenant.tradeName);
    const response: PublicSiteResponse = {
      tenant: { slug: tenant.slug, tradeName: tenant.tradeName },
      site: {
        version: stored?.success ? (published?.version ?? null) : null,
        config: effectiveSiteConfig(config, tenant.tradeName, whiteLabel),
      },
      services,
    };
    await this.cacheSet(tenant.id, response);
    return response;
  }

  private tenantId(): string {
    const id = this.cls.get('tenantId');
    if (!id) throw new Error('SiteService requiere el tenant del host');
    return id;
  }

  private actor(): { kind: 'MEMBERSHIP' | 'PLATFORM_USER'; id: string } {
    const principal = this.cls.get('principal');
    if (principal) return { kind: 'MEMBERSHIP', id: principal.membershipId };
    const support = this.cls.get('supportPrincipal');
    if (support) return { kind: 'PLATFORM_USER', id: support.platformUserId };
    throw new Error('SiteService requiere una sesión verificada');
  }

  /** Serializa las escrituras del sitio de la empresa (número de versión y huecos de borrador y publicada). */
  private async lock(tx: Tx): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`site:${this.tenantId()}`}, 0))`;
  }

  private async invalidate(): Promise<void> {
    try {
      await this.redis.client.del(cacheKey(this.tenantId()));
    } catch (error) {
      this.logger.warn({ err: error }, 'No se pudo invalidar la caché del sitio; caduca sola en 60 s');
    }
  }

  private async cacheGet(tenantId: string): Promise<PublicSiteResponse | null> {
    try {
      const raw = await this.redis.client.get(cacheKey(tenantId));
      return raw ? (JSON.parse(raw) as PublicSiteResponse) : null;
    } catch {
      return null;
    }
  }

  private async cacheSet(tenantId: string, value: PublicSiteResponse): Promise<void> {
    try {
      await this.redis.client.set(cacheKey(tenantId), JSON.stringify(value), 'EX', PUBLIC_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: error }, 'No se pudo escribir la caché del sitio');
    }
  }
}

/** Reglas que el esquema no expresa: tamaño total y contraste AA del tema (los archivos, en assertAssets). */
function assertPublishable(config: SiteConfig): void {
  const bytes = siteConfigBytes(config);
  if (bytes > SITE_MAX_BYTES) {
    throw new AppError(
      'VALIDATION_FAILED',
      `El sitio ocupa ${Math.ceil(bytes / 1000)} KB y el máximo es ${SITE_MAX_BYTES / 1000} KB: acorta las políticas o las preguntas frecuentes`,
      400,
    );
  }
  const problems = themeContrastProblems(config.theme);
  if (problems.length > 0) {
    throw new AppError('VALIDATION_FAILED', problems.map((p) => p.message).join(' '), 400);
  }
}

/**
 * Archivos referenciados (Fase 5.2): de esta empresa (RLS), listos y del tipo correcto. Un archivo ya retirado no se
 * puede publicar ni restaurar.
 */
async function assertAssets(tx: Tx, config: SiteConfig): Promise<void> {
  const refs = [
    { id: config.logoAssetId, kind: 'SITE_LOGO' as const, label: 'El logo' },
    { id: config.hero.imageAssetId, kind: 'SITE_HERO' as const, label: 'La imagen de portada' },
  ];
  for (const ref of refs) {
    if (ref.id === null) continue;
    const found = await tx.fileAsset.findFirst({
      where: { id: ref.id, kind: ref.kind, status: 'READY' },
      select: { id: true },
    });
    if (!found) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${ref.label} no es un archivo disponible de esta empresa`,
        400,
      );
    }
  }
}

/** Lo guardado ya pasó la validación al guardarse; se vuelve a validar al leer por si cambió el esquema. */
function parseStored(json: Prisma.JsonValue): SiteConfig {
  return SiteConfigSchema.parse(json);
}

async function nextVersion(tx: Tx): Promise<number> {
  const last = await tx.siteVersion.findFirst({ select: { version: true }, orderBy: { version: 'desc' } });
  return (last?.version ?? 0) + 1;
}

async function archivePublished(tx: Tx): Promise<void> {
  await tx.siteVersion.updateMany({
    where: { status: 'PUBLISHED' },
    data: { status: 'ARCHIVED', liveSlot: null },
  });
}

function toVersion(row: Row): SiteVersion {
  return {
    version: row.version,
    status: row.status,
    config: parseStored(row.config),
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}
