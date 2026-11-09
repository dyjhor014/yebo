import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AuthTokenRequestSchema,
  type AuthLogoutResponse,
  type AuthRefreshResponse,
  type AuthSessionResponse,
  type AuthTokenResponse,
  type CsrfResponse,
} from '@yebo/contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error';
import { ENV } from '../../../config/env.module';
import type { Env } from '../../../config/env';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { EffectiveModulesService } from '../../access/effective-modules.service';
import { PermissionService } from '../../access/permission.service';
import { AuthenticatedOnly, Public, TenantOperation } from '../../access/route-policy';
import { isLoginAllowed, tenantPhase } from '../../access/tenant-operation';
import { normalizeHost } from '../../tenancy/host';
import { AccessTokenService } from '../access-token.service';
import { AuthorizationCodeService } from '../authorization-code.service';
import { Clock } from '../clock';
import { codeChallengeS256, newCodeVerifier, newOpaqueToken, safeEqual } from '../pkce';
import { RateLimiterService } from '../rate-limiter.service';
import { SessionService, type IssuedTokens } from '../session.service';
import { CookieSigner } from './cookie-signer';
import { COOKIE, REFRESH_COOKIE_PATH, clearCookie, readCookie, setCookie } from './cookies';
import { assertCsrf, issueCsrf } from './csrf';

const AUTH_REQUEST_PURPOSE = 'auth-request';
/** La petición de autorización en curso vive 10 minutos (identity-and-sessions §3). */
const AUTH_REQUEST_TTL_SECONDS = 600;
/** Límite de canjes por IP (los códigos son de 256 bits; esto frena abusos y barridos). */
const TOKEN_LIMIT = { perIp: 60, windowSeconds: 60 } as const;
/** Ruta de retorno interna: empieza por "/" pero no por "//" ni "/\" (sin redirección abierta). */
const RETURN_PATH = /^\/(?![/\\])[^\s\\]{0,511}$/;

const AuthRequestSchema = z.strictObject({
  s: z.string(),
  v: z.string(),
  r: z.string().regex(RETURN_PATH),
  h: z.string(),
  e: z.number().int(),
});

/**
 * Sesión de empresa en su propio dominio (el guard global TenantHostGuard fija el tenant por host, ADR-004).
 * Las cookies nunca se comparten entre dominios; el inicio de sesión pasa siempre por el hub (ADR-022).
 * El flujo de entrada es `@Public('tenant')`: se autentica con otras credenciales (cookie firmada del flujo,
 * código de autorización, refresh token). Solo `GET session` exige la sesión de empresa (guard global).
 */
@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly codes: AuthorizationCodeService,
    private readonly sessions: SessionService,
    private readonly tokens: AccessTokenService,
    private readonly limiter: RateLimiterService,
    private readonly signer: CookieSigner,
    private readonly clock: Clock,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly permissions: PermissionService,
    private readonly modules: EffectiveModulesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Inicia el flujo (identity-and-sessions §3, pasos 2–3): genera `state` y `code_verifier`, los guarda en una
   * cookie firmada de este host y redirige al hub con el reto S256. Nunca se envía un redirect_uri.
   */
  @Get('start')
  @Public('tenant')
  start(@Query('return') returnTo: unknown, @Req() req: Request, @Res() res: Response): void {
    noStore(res);
    this.assertLoginAllowed();
    const host = this.host(req);
    const state = newOpaqueToken();
    const verifier = newCodeVerifier();
    const request = {
      s: state,
      v: verifier,
      r: typeof returnTo === 'string' && RETURN_PATH.test(returnTo) ? returnTo : '/',
      h: host,
      e: Math.floor(this.clock.now().getTime() / 1000) + AUTH_REQUEST_TTL_SECONDS,
    };
    const value = Buffer.from(JSON.stringify(request)).toString('base64url');
    setCookie(res, COOKIE.authRequest, this.signer.sign(AUTH_REQUEST_PURPOSE, value), {
      maxAgeSeconds: AUTH_REQUEST_TTL_SECONDS,
      httpOnly: true,
      sameSite: 'Lax',
    });
    const authorize = new URL(`https://${this.env.AUTH_HUB_HOST}/api/v1/hub/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('tenant_host', host);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', codeChallengeS256(verifier));
    authorize.searchParams.set('code_challenge_method', 'S256');
    res.redirect(302, authorize.toString());
  }

  /**
   * Canje del código (solo POST). Comprueba el `state` contra la cookie firmada de este host (anti login-CSRF) y
   * usa su `code_verifier`; el código queda consumido aunque el canje falle.
   */
  @Post('token')
  @Public('tenant')
  @HttpCode(200)
  async token(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokenResponse> {
    noStore(res);
    if (
      !(await this.limiter.hit(`token:ip:${req.ip}`, TOKEN_LIMIT.perIp, TOKEN_LIMIT.windowSeconds)).allowed
    ) {
      throw new AppError('RATE_LIMITED', 'Demasiados intentos. Espera un momento', 429);
    }
    const parsed = AuthTokenRequestSchema.safeParse(body);
    const pending = this.readAuthRequest(req);
    // La petición de autorización es de un solo uso: se borra pase lo que pase.
    clearCookie(res, COOKIE.authRequest);
    if (!parsed.success || !pending || !safeEqual(pending.s, parsed.data.state)) {
      throw new AppError('UNAUTHENTICATED', 'La solicitud de inicio de sesión no es válida o caducó', 401);
    }
    // Antes del canje: si la empresa ya no admite inicios de sesión, el código no se consume ni se abre sesión.
    this.assertLoginAllowed();
    const issued = await this.codes.redeem({
      code: parsed.data.code,
      codeVerifier: pending.v,
      host: this.host(req),
    });
    this.setSessionCookies(res, issued);
    return { returnTo: pending.r, accessTokenExpiresAt: issued.accessTokenExpiresAt.toISOString() };
  }

  /** Token CSRF del dominio de la empresa (por si la cookie caducó antes que la sesión). */
  @Get('csrf')
  @Public('tenant')
  csrf(@Res({ passthrough: true }) res: Response): CsrfResponse {
    noStore(res);
    return { csrfToken: issueCsrf(res, this.env.AUTH_SESSION_IDLE_MINUTES * 60) };
  }

  /** Renovación (identity-and-sessions §6): rotación con ventana de gracia y detección de reutilización. */
  @Post('refresh')
  @Public('tenant')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthRefreshResponse> {
    noStore(res);
    assertCsrf(req);
    const raw = readCookie(req, COOKIE.refresh);
    if (!raw) throw new AppError('UNAUTHENTICATED', 'Sesión no válida', 401);
    try {
      const issued = await this.sessions.refresh(raw, this.host(req));
      this.setSessionCookies(res, issued);
      return { accessTokenExpiresAt: issued.accessTokenExpiresAt.toISOString() };
    } catch (error) {
      if (error instanceof AppError && error.httpStatus === 401) this.clearSessionCookies(res);
      throw error;
    }
  }

  /**
   * Cierra la sesión de ESTA empresa y devuelve la URL del hub para cerrar también la sesión de identidad
   * ("Cerrar sesión" cierra todas las empresas del navegador, identity-and-sessions §8).
   */
  @Post('logout')
  @Public('tenant')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthLogoutResponse> {
    noStore(res);
    assertCsrf(req);
    const claims = this.tryClaims(req);
    if (claims) await this.sessions.revokeTenantSession(claims.sid, 'LOGOUT');
    this.clearSessionCookies(res);
    return { hubLogoutUrl: `https://${this.env.AUTH_HUB_HOST}/salir` };
  }

  /**
   * Sesión de empresa del request y permisos efectivos. La verificación (firma, `tid` = host, sesión en
   * PostgreSQL y versión de permisos) la hace el guard global AuthenticationGuard (Fase 3.3).
   */
  @Get('session')
  @AuthenticatedOnly()
  @TenantOperation('READ')
  async session(@Res({ passthrough: true }) res: Response): Promise<AuthSessionResponse> {
    noStore(res);
    if (this.cls.get('supportPrincipal')) {
      // El staff de soporte no tiene sesión de persona en la empresa (Fase 4.6).
      throw new AppError('FORBIDDEN', 'No disponible en una sesión de soporte', 403);
    }
    const principal = this.cls.get('principal');
    const tenantId = this.cls.get('tenantId');
    if (!principal || !tenantId) throw new Error('AuthenticationGuard no fijó la sesión');
    return {
      userId: principal.userId,
      tenantId,
      membershipId: principal.membershipId,
      accessTokenExpiresAt: new Date(principal.accessTokenExpiresAt * 1000).toISOString(),
      permissions: [...(await this.permissions.current())].sort(),
      modules: [...(await this.modules.current())].sort(),
    };
  }

  /** Fila «Login» de la matriz de estados (multitenancy §5.2): tras el periodo de cierre no se entra. */
  private assertLoginAllowed(): void {
    const tenant = this.cls.get('tenant');
    if (!tenant || !isLoginAllowed(tenantPhase(tenant, this.clock.now()))) {
      throw new AppError('TENANT_RESTRICTED', 'Esta empresa ya no está disponible en YEBO', 403);
    }
  }

  /** Access token válido Y del tenant de este host (ADR-004); si no, `null`. */
  private tryClaims(req: Request): ReturnType<AccessTokenService['verify']> | null {
    const token = readCookie(req, COOKIE.access);
    if (!token) return null;
    try {
      const claims = this.tokens.verify(token);
      return claims.tid === this.cls.get('tenantId') ? claims : null;
    } catch {
      return null;
    }
  }

  private readAuthRequest(req: Request): z.infer<typeof AuthRequestSchema> | null {
    const value = this.signer.verify(AUTH_REQUEST_PURPOSE, readCookie(req, COOKIE.authRequest));
    if (!value) return null;
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const parsed = AuthRequestSchema.safeParse(json);
    if (!parsed.success) return null;
    const expired = parsed.data.e <= Math.floor(this.clock.now().getTime() / 1000);
    return expired || parsed.data.h !== this.host(req) ? null : parsed.data;
  }

  private setSessionCookies(res: Response, issued: IssuedTokens): void {
    const now = this.clock.now().getTime();
    setCookie(res, COOKIE.access, issued.accessToken, {
      maxAgeSeconds: (issued.accessTokenExpiresAt.getTime() - now) / 1000,
      httpOnly: true,
      sameSite: 'Lax',
    });
    const refreshSeconds = (issued.refreshTokenExpiresAt.getTime() - now) / 1000;
    setCookie(res, COOKIE.refresh, issued.refreshToken, {
      maxAgeSeconds: refreshSeconds,
      httpOnly: true,
      sameSite: 'Strict',
      path: REFRESH_COOKIE_PATH,
    });
    issueCsrf(res, refreshSeconds);
  }

  private clearSessionCookies(res: Response): void {
    clearCookie(res, COOKIE.access);
    clearCookie(res, COOKIE.refresh, REFRESH_COOKIE_PATH);
  }

  private host(req: Request): string {
    const host = normalizeHost(req.hostname);
    if (!host || !this.cls.get('tenant')) throw new Error('TenantHostGuard no fijó el tenant');
    return host;
  }
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}
