import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../../common/errors/app-error';
import { ENV } from '../../../config/env.module';
import type { Env } from '../../../config/env';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { routePolicyForContext } from '../../access/route-policy';
import { readCookie } from '../../identity/http/cookies';
import { assertCsrf } from '../../identity/http/csrf';
import { normalizeHost } from '../../tenancy/host';
import { PlatformAuthService } from '../platform-auth.service';
import { PLATFORM_COOKIE } from './platform-cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Guard GLOBAL del realm de plataforma (Fase 4.1), registrado en la cadena de access.module.ts. Actúa en las rutas
 * `@PlatformProtected`/`@PlatformAuthenticated` y `@Public('admin')`:
 *  1. el host debe ser PLATFORM_ADMIN_HOST (si no, 404, como un recurso inexistente);
 *  2. rutas de plataforma: sesión del staff verificada en PostgreSQL (con MFA activada), permiso de plataforma y CSRF
 *     en las mutaciones. Una cookie de sesión de empresa no sirve aquí, y la del staff no sirve en las empresas.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: PlatformAuthService,
    private readonly cls: ClsService<RequestContextStore>,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = routePolicyForContext(this.reflector, context);
    const adminPublic = policy.kind === 'public' && policy.scope === 'admin';
    if (policy.kind !== 'platform' && !adminPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (normalizeHost(request.hostname) !== this.env.PLATFORM_ADMIN_HOST) {
      throw new AppError('NOT_FOUND', 'Recurso no encontrado', 404);
    }
    if (policy.kind !== 'platform') return true;

    const principal = await this.auth.checkSession(readCookie(request, PLATFORM_COOKIE.session));
    if (!principal) throw new AppError('UNAUTHENTICATED', 'Sesión no válida', 401);
    if (policy.permission && !principal.permissions.has(policy.permission)) {
      throw new AppError('FORBIDDEN', 'No tienes permiso para realizar esta operación', 403);
    }
    if (!SAFE_METHODS.has(request.method)) assertCsrf(request);
    this.cls.set('platformPrincipal', principal);
    return true;
  }
}
