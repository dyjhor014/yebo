import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  HubAuthorizeQuerySchema,
  HubInvitationRegisterSchema,
  HubInvitationTokenSchema,
  HubLoginRequestSchema,
  type HubInvitationAccepted,
  type HubInvitationPreview,
  type CsrfResponse,
  type HubBrandingResponse,
  type HubMembershipsResponse,
} from '@yebo/contracts';
import type { Request, Response } from 'express';
import { AppError } from '../../../common/errors/app-error';
import { normalizeHost } from '../../tenancy/host';
import { Public } from '../../access/route-policy';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { AuthorizationCodeService } from '../authorization-code.service';
import { Clock } from '../clock';
import { HubAuthService } from '../hub-auth.service';
import { InvitationAcceptanceService } from '../invitation-acceptance.service';
import { SessionService } from '../session.service';
import { CookieSigner } from './cookie-signer';
import { COOKIE, clearCookie, readCookie, setCookie } from './cookies';
import { assertCsrf, issueCsrf } from './csrf';
import { HubHostGuard } from './hub-host.guard';

const HUB_COOKIE_PURPOSE = 'hub-session';
const CSRF_MAX_AGE_SECONDS = 2 * 60 * 60;

/**
 * Hub de cuentas (`cuentas.<dominio>`, ADR-022): login, sesión de identidad y emisión de códigos de autorización.
 * Es el único lugar donde se escriben credenciales. Las pantallas las sirve apps/web en el mismo host.
 */
@ApiTags('hub')
@Controller({ path: 'hub', version: '1' })
@Public('hub')
@UseGuards(HubHostGuard)
export class HubController {
  constructor(
    private readonly hub: HubAuthService,
    private readonly codes: AuthorizationCodeService,
    private readonly sessions: SessionService,
    private readonly tenants: TenantResolverService,
    private readonly signer: CookieSigner,
    private readonly clock: Clock,
    private readonly invitations: InvitationAcceptanceService,
  ) {}

  @Get('csrf')
  csrf(@Res({ passthrough: true }) res: Response): CsrfResponse {
    noStore(res);
    return { csrfToken: issueCsrf(res, CSRF_MAX_AGE_SECONDS) };
  }

  /**
   * Punto de autorización (identity-and-sessions §3–4). Solo `response_type=code` con PKCE S256; no admite
   * `redirect_uri` (se deriva del dominio verificado). Errores de parámetros → 400 SIN redirigir.
   */
  @Get('authorize')
  async authorize(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    noStore(res);
    const parsed = HubAuthorizeQuerySchema.safeParse(query);
    const host = parsed.success ? normalizeHost(parsed.data.tenant_host) : null;
    if (!parsed.success || !host)
      throw new AppError('BAD_REQUEST', 'Solicitud de autorización no válida', 400);
    // Solo dominios VERIFIED: nunca se redirige a un host que no sea de una empresa.
    if (!(await this.tenants.resolve(host)))
      throw new AppError('BAD_REQUEST', 'Solicitud de autorización no válida', 400);

    const identitySessionId = this.signer.verify(HUB_COOKIE_PURPOSE, readCookie(req, COOKIE.hub));
    const result = identitySessionId
      ? await this.codes.issue({
          identitySessionId,
          tenantHost: host,
          codeChallenge: parsed.data.code_challenge,
        })
      : ({ kind: 'login-required' } as const);

    if (result.kind === 'issued') {
      const target = new URL(result.redirectUri);
      target.searchParams.set('code', result.code);
      target.searchParams.set('state', parsed.data.state);
      res.redirect(302, target.toString());
      return;
    }
    const params = new URLSearchParams(parsed.data);
    res.redirect(
      302,
      result.kind === 'no-access'
        ? `/sin-acceso?tenant_host=${encodeURIComponent(host)}`
        : `/login?${params}`,
    );
  }

  @Post('login')
  @HttpCode(204)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    noStore(res);
    assertCsrf(req);
    const parsed = HubLoginRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError('UNAUTHENTICATED', 'Correo o contraseña incorrectos', 401);
    const session = await this.hub.login({
      email: parsed.data.email,
      password: parsed.data.password,
      ip: req.ip ?? 'desconocida',
      ...(typeof req.headers['user-agent'] === 'string' && { userAgent: req.headers['user-agent'] }),
    });
    setCookie(res, COOKIE.hub, this.signer.sign(HUB_COOKIE_PURPOSE, session.identitySessionId), {
      maxAgeSeconds: (session.absoluteExpiresAt.getTime() - this.clock.now().getTime()) / 1000,
      httpOnly: true,
      sameSite: 'Lax',
    });
  }

  /** "Cerrar sesión": revoca la sesión de identidad de este navegador y todas sus sesiones de empresa. */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    noStore(res);
    assertCsrf(req);
    const identitySessionId = this.signer.verify(HUB_COOKIE_PURPOSE, readCookie(req, COOKIE.hub));
    if (identitySessionId) await this.sessions.revokeIdentitySession(identitySessionId, 'LOGOUT');
    clearCookie(res, COOKIE.hub);
  }

  @Get('me/memberships')
  async memberships(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HubMembershipsResponse> {
    noStore(res);
    const identitySessionId = this.signer.verify(HUB_COOKIE_PURPOSE, readCookie(req, COOKIE.hub));
    const identity = identitySessionId
      ? await this.sessions.findLiveIdentitySession(identitySessionId)
      : null;
    if (!identity) throw new AppError('UNAUTHENTICATED', 'Inicia sesión para continuar', 401);
    return { memberships: await this.hub.listMemberships(identity.userId) };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Invitaciones (Fase 4.3b). El token viaja en el cuerpo (en la página, en el fragmento #), nunca en la URL.
  // -------------------------------------------------------------------------------------------------------------

  /** Empresa, correo invitado y caducidad. No revela si existe una cuenta con ese correo. */
  @Post('invitations/preview')
  @HttpCode(200)
  async previewInvitation(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HubInvitationPreview> {
    noStore(res);
    assertCsrf(req);
    const parsed = HubInvitationTokenSchema.safeParse(body);
    return this.invitations.preview(parsed.success ? parsed.data.token : null, ip(req));
  }

  /** Acepta con la sesión del hub de este navegador. */
  @Post('invitations/accept')
  @HttpCode(200)
  async acceptInvitation(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HubInvitationAccepted> {
    noStore(res);
    assertCsrf(req);
    const parsed = HubInvitationTokenSchema.safeParse(body);
    const identitySessionId = this.signer.verify(HUB_COOKIE_PURPOSE, readCookie(req, COOKIE.hub));
    return this.invitations.accept(identitySessionId, parsed.success ? parsed.data.token : null, ip(req));
  }

  /** Crea la cuenta del correo invitado, acepta y abre la sesión del hub (decisión del 2026-11-10). */
  @Post('invitations/register')
  @HttpCode(200)
  async registerInvitation(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HubInvitationAccepted> {
    noStore(res);
    assertCsrf(req);
    const parsed = HubInvitationRegisterSchema.safeParse(body);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Revisa tu nombre y tu contraseña', 400);
    const result = await this.invitations.register({
      ...parsed.data,
      ip: ip(req),
      ...(typeof req.headers['user-agent'] === 'string' && { userAgent: req.headers['user-agent'] }),
    });
    setCookie(res, COOKIE.hub, this.signer.sign(HUB_COOKIE_PURPOSE, result.identitySessionId), {
      maxAgeSeconds: (result.absoluteExpiresAt.getTime() - this.clock.now().getTime()) / 1000,
      httpOnly: true,
      sameSite: 'Lax',
    });
    return { tradeName: result.tradeName, tenantHost: result.tenantHost };
  }

  /** Nombre de la empresa desde la que se inicia el acceso (la pantalla de login lleva su marca, D3.1). */
  @Get('branding')
  async branding(@Query('tenant_host') tenantHost: unknown): Promise<HubBrandingResponse> {
    const tenant = typeof tenantHost === 'string' ? await this.tenants.resolve(tenantHost) : null;
    if (!tenant) throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
    return { tradeName: tenant.tradeName };
  }
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function ip(req: Request): string {
  return req.ip ?? 'desconocida';
}
