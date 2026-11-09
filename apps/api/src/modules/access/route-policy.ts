import { SetMetadata, applyDecorators } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import type { PermissionCode } from './permission-catalog';
import type { TenantOperationCategory } from './tenant-operation';

/**
 * Política de acceso por ruta (Fase 3.3; diseño aceptado el 2026-11-09 en phase-3-plan):
 * DENEGAR POR DEFECTO. Toda ruta exige sesión de empresa salvo que lleve `@Public(...)`, y toda ruta protegida
 * declara qué permiso exige (o que basta con estar autenticado) y su categoría de operación (ADR-023).
 */
const PUBLIC = 'yebo:access:public';
const PERMISSION = 'yebo:access:permission';
const AUTHENTICATED_ONLY = 'yebo:access:authenticated-only';
const OPERATION = 'yebo:access:operation';

/**
 * Dónde vive una ruta pública:
 * - `tenant`: en el dominio de una empresa (el host se resuelve, pero no se exige sesión);
 * - `hub`: en el hub de cuentas (su propio guard valida el host);
 * - `none`: sin host de empresa (health).
 * Cada ruta pública debe figurar además en `PUBLIC_ROUTES` (public-routes.ts).
 */
export type PublicScope = 'tenant' | 'hub' | 'none';

export const Public = (scope: PublicScope): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC, scope);

/** Exige un permiso del catálogo (security.md §2). */
export const RequirePermission = (code: PermissionCode): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION, code);

/** Basta con una sesión de empresa válida (p. ej., consultar la propia sesión). Debe ser una decisión explícita. */
export const AuthenticatedOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHENTICATED_ONLY, true);

/** Categoría de la operación para la matriz de estados del tenant (multitenancy §5.1). */
export const TenantOperation = (category: TenantOperationCategory): MethodDecorator & ClassDecorator =>
  SetMetadata(OPERATION, category);

/** Atajo para rutas protegidas por permiso: siempre van juntos el permiso y la categoría. */
export const Protected = (code: PermissionCode, category: TenantOperationCategory) =>
  applyDecorators(RequirePermission(code), TenantOperation(category));

export type RoutePolicy =
  | { kind: 'public'; scope: PublicScope }
  | {
      kind: 'protected';
      /** `null` si la ruta es `@AuthenticatedOnly()`. */
      permission: PermissionCode | null;
      operation: TenantOperationCategory;
    };

/** Error de configuración: la ruta no declara su política. Se responde 500 y la prueba de barrido lo detecta. */
export class MissingRoutePolicyError extends AppError {
  constructor(route: string, detail: string) {
    super('INTERNAL_ERROR', 'Error interno', 500);
    this.message = `Ruta sin política de acceso completa (${route}): ${detail}`;
  }
}

/** Lee la política de la ruta (método primero, después la clase). */
type MetadataTarget = ReturnType<ExecutionContext['getHandler']> | ReturnType<ExecutionContext['getClass']>;

export function routePolicyOf(
  reflector: Reflector,
  targets: [handler: MetadataTarget, controller: MetadataTarget],
  routeName: string,
): RoutePolicy {
  const scope = reflector.getAllAndOverride<PublicScope | undefined>(PUBLIC, targets);
  const permission = reflector.getAllAndOverride<PermissionCode | undefined>(PERMISSION, targets) ?? null;
  const authenticatedOnly =
    reflector.getAllAndOverride<boolean | undefined>(AUTHENTICATED_ONLY, targets) === true;
  const operation = reflector.getAllAndOverride<TenantOperationCategory | undefined>(OPERATION, targets);
  if (scope) {
    // Un @Public de clase no debe volver pública en silencio una ruta que declara permiso: es una contradicción.
    if (permission || authenticatedOnly || operation) {
      throw new MissingRoutePolicyError(
        routeName,
        'es @Public y a la vez declara permiso, sesión u operación',
      );
    }
    return { kind: 'public', scope };
  }
  if (permission && authenticatedOnly) {
    throw new MissingRoutePolicyError(routeName, 'declara a la vez @RequirePermission y @AuthenticatedOnly');
  }
  if (!permission && !authenticatedOnly) {
    throw new MissingRoutePolicyError(routeName, 'falta @RequirePermission(...) o @AuthenticatedOnly()');
  }
  if (!operation) throw new MissingRoutePolicyError(routeName, 'falta @TenantOperation(...)');
  return { kind: 'protected', permission, operation };
}

export function routePolicyForContext(reflector: Reflector, context: ExecutionContext): RoutePolicy {
  const handler = context.getHandler();
  const controller = context.getClass();
  return routePolicyOf(reflector, [handler, controller], `${controller.name}.${handler.name}`);
}
