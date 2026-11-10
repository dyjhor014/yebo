import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  SaveSiteDraftRequestSchema,
  SiteAssetKindSchema,
  type SiteAsset,
  type SiteAssetsResponse,
  type SiteEditorResponse,
  type SiteVersionsResponse,
} from '@yebo/contracts';
import { createZodDto } from 'nestjs-zod';
import { Protected } from '../../access/route-policy';
import { AppError } from '../../../common/errors/app-error';
import { SiteAssetsService } from '../site-assets.service';
import { SiteService } from '../site.service';

class SaveSiteDraftRequestDto extends createZodDto(SaveSiteDraftRequestSchema) {}

/**
 * «Mi sitio» de la empresa (Fase 5.1; F5-Q5: permiso site.manage). Leer es READ; guardar, publicar y restaurar son
 * CONFIGURE (bloqueado en SUSPENDED, EXPIRED y CANCELLED; ADR-023). El staff de YEBO solo con soporte FULL.
 */
@ApiTags('site')
@Controller({ path: 'site', version: '1' })
export class SiteController {
  constructor(
    private readonly site: SiteService,
    private readonly assets: SiteAssetsService,
  ) {}

  @Get()
  @Protected('site.manage', 'READ')
  editor(): Promise<SiteEditorResponse> {
    return this.site.editor();
  }

  @Put('draft')
  @Protected('site.manage', 'CONFIGURE')
  saveDraft(@Body() body: SaveSiteDraftRequestDto): Promise<SiteEditorResponse> {
    return this.site.saveDraft(body.config);
  }

  @Post('publish')
  @HttpCode(200)
  @Protected('site.manage', 'CONFIGURE')
  publish(): Promise<SiteEditorResponse> {
    return this.site.publish();
  }

  @Get('versions')
  @Protected('site.manage', 'READ')
  versions(): Promise<SiteVersionsResponse> {
    return this.site.versions();
  }

  @Post('versions/:version/restore')
  @HttpCode(200)
  @Protected('site.manage', 'CONFIGURE')
  restore(@Param('version') version: string): Promise<SiteEditorResponse> {
    return this.site.restore(/^\d{1,6}$/.test(version) ? Number(version) : -1);
  }

  /** Archivos del sitio (Fase 5.2). La imagen va en el cuerpo (image/png, image/jpeg o image/webp; ≤ 5 MB). */
  @Get('assets')
  @Protected('site.manage', 'READ')
  async listAssets(): Promise<SiteAssetsResponse> {
    return { assets: await this.assets.list() };
  }

  @Post('assets')
  @Protected('site.manage', 'CONFIGURE')
  uploadAsset(@Query('kind') kind: unknown, @Body() body: unknown): Promise<SiteAsset> {
    const parsed = SiteAssetKindSchema.safeParse(kind);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Indica kind=logo o kind=hero', 400);
    return this.assets.upload(parsed.data, body);
  }
}
