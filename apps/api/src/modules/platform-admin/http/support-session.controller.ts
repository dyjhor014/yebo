import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../../common/errors/app-error';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { Public } from '../../access/route-policy';
import { COOKIE, setCookie } from '../../identity/http/cookies';
import { issueCsrf } from '../../identity/http/csrf';
import { SupportAccessService } from '../support-access.service';

/**
 * Canje del enlace de soporte en el HOST DE LA EMPRESA (Fase 4.6). El código es de un solo uso y dura 60 s; el
 * tenant sale del host, así que un código de otra empresa no existe aquí (RLS). Abre la sesión de soporte en una
 * cookie propia y lleva al panel de la empresa.
 */
@ApiTags('support')
@Controller({ path: 'support', version: '1' })
@Public('tenant')
export class SupportSessionController {
  constructor(
    private readonly support: SupportAccessService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  @Get('session')
  async open(@Query('code') code: unknown, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new Error('TenantHostGuard no fijó el tenant');
    const session = typeof code === 'string' ? await this.support.redeem(tenantId, code) : null;
    if (!session) throw new AppError('UNAUTHENTICATED', 'El enlace de soporte no es válido o ya se usó', 401);
    setCookie(res, COOKIE.support, session.token, {
      maxAgeSeconds: session.maxAgeSeconds,
      httpOnly: true,
      sameSite: 'Lax',
    });
    issueCsrf(res, session.maxAgeSeconds);
    res.redirect(302, '/panel');
  }
}
