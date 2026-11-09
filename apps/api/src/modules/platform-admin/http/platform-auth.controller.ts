import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PlatformLoginRequestSchema,
  PlatformMfaCodeRequestSchema,
  PlatformSetupPasswordRequestSchema,
  type CsrfResponse,
  type PlatformLoginResponse,
  type PlatformMfaEnrollResponse,
  type PlatformSessionResponse,
} from '@yebo/contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../../common/errors/app-error';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { PlatformAuthenticated, Public } from '../../access/route-policy';
import { Clock } from '../../identity/clock';
import { CookieSigner } from '../../identity/http/cookie-signer';
import { clearCookie, readCookie, setCookie } from '../../identity/http/cookies';
import { assertCsrf, issueCsrf } from '../../identity/http/csrf';
import { PlatformAuthService, type IssuedPlatformSession, type RequestMeta } from '../platform-auth.service';
import { PENDING_MFA_PURPOSE, PENDING_MFA_TTL_SECONDS, PLATFORM_COOKIE } from './platform-cookies';

const CSRF_MAX_AGE_SECONDS = 12 * 3600;
const PENDING_INVALID = () =>
  new AppError('UNAUTHENTICATED', 'El inicio de sesión caducó. Vuelve a escribir tu contraseña', 401);

/**
 * Autenticación del staff en el host del panel (Fase 4.1). Login en dos pasos obligatorios:
 * contraseña → (alta de MFA en el primer acceso | código TOTP) → sesión. Todas las mutaciones exigen CSRF.
 */
@ApiTags('platform')
@Controller({ path: 'platform/auth', version: '1' })
export class PlatformAuthController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly signer: CookieSigner,
    private readonly clock: Clock,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  @Get('csrf')
  @Public('admin')
  csrf(@Res({ passthrough: true }) res: Response): CsrfResponse {
    noStore(res);
    return { csrfToken: issueCsrf(res, CSRF_MAX_AGE_SECONDS) };
  }

  @Post('login')
  @Public('admin')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlatformLoginResponse> {
    noStore(res);
    assertCsrf(req);
    const parsed = PlatformLoginRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError('UNAUTHENTICATED', 'Correo o contraseña incorrectos', 401);
    const result = await this.auth.login(parsed.data, meta(req));
    const expires = Math.floor(this.clock.now().getTime() / 1000) + PENDING_MFA_TTL_SECONDS;
    setCookie(
      res,
      PLATFORM_COOKIE.pendingMfa,
      this.signer.sign(PENDING_MFA_PURPOSE, `${result.platformUserId}:${expires}`),
      { maxAgeSeconds: PENDING_MFA_TTL_SECONDS, httpOnly: true, sameSite: 'Strict' },
    );
    return { next: result.next };
  }

  @Post('mfa/enroll')
  @Public('admin')
  @HttpCode(200)
  async enroll(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlatformMfaEnrollResponse> {
    noStore(res);
    assertCsrf(req);
    return this.auth.enrollMfa(this.pendingUser(req));
  }

  @Post('mfa/activate')
  @Public('admin')
  @HttpCode(204)
  async activate(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    assertCsrf(req);
    const session = await this.auth.activateMfa(this.pendingUser(req), code(body), meta(req));
    this.startSession(res, session);
  }

  @Post('mfa/verify')
  @Public('admin')
  @HttpCode(204)
  async verify(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    assertCsrf(req);
    const session = await this.auth.verifyMfa(this.pendingUser(req), code(body), meta(req));
    this.startSession(res, session);
  }

  /** Fija la contraseña con el enlace de configuración (alta o restablecimiento). */
  @Post('setup')
  @Public('admin')
  @HttpCode(204)
  async setup(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    assertCsrf(req);
    const parsed = PlatformSetupPasswordRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError('UNAUTHENTICATED', 'El enlace no es válido o caducó', 401);
    await this.auth.setupPassword(parsed.data.token, parsed.data.password, meta(req));
  }

  @Get('session')
  @PlatformAuthenticated()
  session(@Res({ passthrough: true }) res: Response): PlatformSessionResponse {
    noStore(res);
    const p = this.principal();
    return {
      platformUserId: p.platformUserId,
      email: p.email,
      fullName: p.fullName,
      role: p.role,
      permissions: [...p.permissions].sort(),
    };
  }

  @Post('logout')
  @PlatformAuthenticated()
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    noStore(res);
    await this.auth.logout(this.principal(), meta(req));
    clearCookie(res, PLATFORM_COOKIE.session);
  }

  private startSession(res: Response, session: IssuedPlatformSession): void {
    clearCookie(res, PLATFORM_COOKIE.pendingMfa);
    setCookie(res, PLATFORM_COOKIE.session, session.token, {
      maxAgeSeconds: (session.absoluteExpiresAt.getTime() - this.clock.now().getTime()) / 1000,
      httpOnly: true,
      sameSite: 'Strict',
    });
  }

  /** Usuario del login pendiente: cookie firmada de este host, no caducada. */
  private pendingUser(req: Request): string {
    const value = this.signer.verify(PENDING_MFA_PURPOSE, readCookie(req, PLATFORM_COOKIE.pendingMfa));
    const match = value?.match(/^([0-9a-f-]{36}):(\d+)$/);
    if (!match || Number(match[2]) <= Math.floor(this.clock.now().getTime() / 1000)) throw PENDING_INVALID();
    return match[1] as string;
  }

  private principal() {
    const principal = this.cls.get('platformPrincipal');
    if (!principal) throw new Error('PlatformGuard no fijó la sesión del staff');
    return principal;
  }
}

function code(body: unknown): string {
  const parsed = PlatformMfaCodeRequestSchema.safeParse(body);
  if (!parsed.success) throw new AppError('UNAUTHENTICATED', 'El código no es válido', 401);
  return parsed.data.code;
}

export function meta(req: Request): RequestMeta {
  return {
    ...(req.ip && { ip: req.ip }),
    ...(typeof req.headers['user-agent'] === 'string' && { userAgent: req.headers['user-agent'] }),
  };
}

export function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}
