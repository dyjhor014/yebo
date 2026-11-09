import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../../common/errors/app-error';
import type { RequestContextStore } from '../../../infrastructure/context/request-context';
import { routePolicyForContext } from '../../access/route-policy';
import { AccessTokenService, type AccessTokenClaims } from '../access-token.service';
import { SessionService } from '../session.service';
import { COOKIE, readCookie } from './cookies';
import { assertCsrf } from './csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UNAUTHENTICATED = () => new AppError('UNAUTHENTICATED', 'Sesión no válida', 401);

/**
 * Guard GLOBAL de autenticación (Fase 3.3; identity-and-sessions §7). En TODA ruta no pública verifica, en cada
 * petición:
 *  1. el access token (firma EdDSA, `iss`, `aud`, vida ≤ 900 s);
 *  2. `tid` = tenant resuelto por el host (ADR-004);
 *  3. la sesión en PostgreSQL (sesión de empresa e identidad vigentes, membresía y usuario ACTIVE), y que
 *     `sub`, `mid` y el tenant del token coincidan con los de la sesión;
 *  4. `ver` = `permissions_version` vigente; si no, `401 PERMISSIONS_CHANGED` (el cliente renueva en silencio).
 * En las mutaciones exige además el token CSRF (*double submit*): la sesión viaja en una cookie.
 * El motivo concreto de un 401 no se expone al cliente.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (routePolicyForContext(this.reflector, context).kind === 'public') return true;
    const request = context.switchToHttp().getRequest<Request>();
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new Error('TenantHostGuard no fijó el tenant antes de AuthenticationGuard');

    const claims = this.verifiedClaims(request);
    if (!claims || claims.tid !== tenantId) throw UNAUTHENTICATED();
    const check = await this.sessions.checkSession(claims.sid);
    if (
      !check.active ||
      check.tenantId !== tenantId ||
      check.userId !== claims.sub ||
      check.membershipId !== claims.mid
    ) {
      throw UNAUTHENTICATED();
    }
    if (check.permissionsVersion !== claims.ver) {
      throw new AppError('PERMISSIONS_CHANGED', 'Tus permisos cambiaron; renueva la sesión', 401);
    }
    if (!SAFE_METHODS.has(request.method)) assertCsrf(request);

    this.cls.set('principal', {
      userId: check.userId,
      membershipId: check.membershipId,
      sessionId: claims.sid,
      accessTokenExpiresAt: claims.exp,
    });
    return true;
  }

  private verifiedClaims(request: Request): AccessTokenClaims | null {
    const token = readCookie(request, COOKIE.access);
    if (!token) return null;
    try {
      return this.tokens.verify(token);
    } catch {
      return null;
    }
  }
}
