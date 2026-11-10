import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  SaveSiteDraftRequestSchema,
  type SiteEditorResponse,
  type SiteVersionsResponse,
} from '@yebo/contracts';
import { createZodDto } from 'nestjs-zod';
import { Protected } from '../../access/route-policy';
import { SiteService } from '../site.service';

class SaveSiteDraftRequestDto extends createZodDto(SaveSiteDraftRequestSchema) {}

/**
 * «Mi sitio» de la empresa (Fase 5.1; F5-Q5: permiso site.manage). Leer es READ; guardar, publicar y restaurar son
 * CONFIGURE (bloqueado en SUSPENDED, EXPIRED y CANCELLED; ADR-023). El staff de YEBO solo con soporte FULL.
 */
@ApiTags('site')
@Controller({ path: 'site', version: '1' })
export class SiteController {
  constructor(private readonly site: SiteService) {}

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
}
