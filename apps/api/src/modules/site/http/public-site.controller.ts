import { Controller, Get } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { PublicSiteResponseSchema, type PublicSiteResponse } from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import { createZodDto } from 'nestjs-zod';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { Public } from '../../access/route-policy';
import { SiteService } from '../site.service';

class PublicSiteResponseDto extends createZodDto(PublicSiteResponseSchema) {}

/**
 * Portal público de la empresa del host (ADR-004; Fase 5.1). Sin autenticación: solo la versión PUBLICADA, ya con lo
 * que permite el plan (F5-Q4), y los servicios que opera. Único archivo de site con @Public (eslint.config.mjs).
 */
@ApiTags('public')
@Controller({ path: 'public', version: '1' })
@Public('tenant')
export class PublicSiteController {
  constructor(
    private readonly cls: ClsService<RequestContextStore>,
    private readonly site: SiteService,
  ) {}

  @Get('site')
  @ApiOkResponse({ type: PublicSiteResponseDto })
  @ApiNotFoundResponse({ description: 'Host sin empresa asociada o dominio no verificado' })
  siteOfHost(): Promise<PublicSiteResponse> {
    const tenant = this.cls.get('tenant');
    if (!tenant) throw new Error('TenantHostGuard no fijó el tenant');
    return this.site.publicSite(tenant);
  }
}
