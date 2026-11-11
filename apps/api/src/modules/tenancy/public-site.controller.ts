import { Controller, Get } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { PublicSiteResponseSchema, type PublicSiteResponse } from '@yebo/contracts';
import { ClsService } from 'nestjs-cls';
import { createZodDto } from 'nestjs-zod';
import type { RequestContextStore } from '../../infrastructure/context/request-context';
import { Public } from '../access/route-policy';

class PublicSiteResponseDto extends createZodDto(PublicSiteResponseSchema) {}

@ApiTags('public')
@Controller({ path: 'public', version: '1' })
@Public('tenant')
export class PublicSiteController {
  constructor(private readonly cls: ClsService<RequestContextStore>) {}

  /** Identidad pública de la empresa del host. Sin autenticación. */
  @Get('site')
  @ApiOkResponse({ type: PublicSiteResponseDto })
  @ApiNotFoundResponse({ description: 'Host sin empresa asociada o dominio no verificado' })
  site(): PublicSiteResponse {
    const tenant = this.cls.get('tenant');
    if (!tenant) throw new Error('TenantHostGuard no fijó el tenant');
    return { tenant: { slug: tenant.slug, tradeName: tenant.tradeName } };
  }
}
