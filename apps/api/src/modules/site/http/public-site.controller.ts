import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { PublicSiteResponseSchema, type PublicSiteResponse } from '@yebo/contracts';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { createZodDto } from 'nestjs-zod';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { Public } from '../../access/route-policy';
import { AppError } from '../../../common/errors/app-error';
import { SiteAssetsService } from '../site-assets.service';
import { SiteService } from '../site.service';

class PublicSiteResponseDto extends createZodDto(PublicSiteResponseSchema) {}

/**
 * Portal público de la empresa del host (ADR-004; Fase 5.1). Sin autenticación: solo la versión PUBLICADA, ya con lo
 * que permite el plan (F5-Q4), y los servicios que opera; y sus archivos públicos (Fase 5.2). Único archivo de site
 * con @Public (eslint.config.mjs).
 */
@ApiTags('public')
@Controller({ path: 'public', version: '1' })
@Public('tenant')
export class PublicSiteController {
  constructor(
    private readonly cls: ClsService<RequestContextStore>,
    private readonly site: SiteService,
    private readonly assets: SiteAssetsService,
  ) {}

  @Get('site')
  @ApiOkResponse({ type: PublicSiteResponseDto })
  @ApiNotFoundResponse({ description: 'Host sin empresa asociada o dominio no verificado' })
  siteOfHost(): Promise<PublicSiteResponse> {
    const tenant = this.cls.get('tenant');
    if (!tenant) throw new Error('TenantHostGuard no fijó el tenant');
    return this.site.publicSite(tenant);
  }

  /** Archivo público de la empresa del host (logo o portada ya recodificados). Inmutable: caché de un año. */
  @Get('assets/:assetId')
  async asset(@Param('assetId') assetId: string, @Res() res: Response): Promise<void> {
    await this.sendAsset(assetId, 'original', res);
  }

  /** Favicon de 64 × 64 generado a partir de un logo. */
  @Get('assets/:assetId/favicon')
  async favicon(@Param('assetId') assetId: string, @Res() res: Response): Promise<void> {
    await this.sendAsset(assetId, 'favicon', res);
  }

  private async sendAsset(assetId: string, variant: 'original' | 'favicon', res: Response) {
    const object = await this.assets.publicObject(assetId, variant);
    if (!object) throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', object.etag);
    // Una imagen nunca se interpreta como documento ni se ejecuta.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // If-None-Match → 304: lo resuelve Express (res.send compara la ETag).
    res.type(object.contentType).send(object.body);
  }
}
