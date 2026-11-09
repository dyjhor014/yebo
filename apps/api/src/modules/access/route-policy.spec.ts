import { Reflector } from '@nestjs/core';
import {
  AuthenticatedOnly,
  MissingRoutePolicyError,
  Protected,
  Public,
  RequirePermission,
  routePolicyOf,
  TenantOperation,
} from './route-policy';

/* eslint-disable no-restricted-syntax -- la prueba ejercita el propio decorador @Public */
class Fixture {
  @Public('tenant') publicRoute(): void {}
  @Protected('members.read', 'READ') protectedRoute(): void {}
  @AuthenticatedOnly() @TenantOperation('READ') authenticatedOnly(): void {}
  @RequirePermission('members.read') withoutOperation(): void {}
  @TenantOperation('READ') withoutPermission(): void {}
  @RequirePermission('members.read') @AuthenticatedOnly() @TenantOperation('READ') both(): void {}
  bare(): void {}
}

@Public('none')
class PublicController {
  @Protected('members.read', 'READ') overridden(): void {}
  inherited(): void {}
}
/* eslint-enable no-restricted-syntax */

const reflector = new Reflector();
const policy = (cls: { prototype: object }, method: string) =>
  routePolicyOf(
    reflector,
    [(cls.prototype as Record<string, () => void>)[method] as () => void, cls as unknown as () => void],
    method,
  );

describe('Política de ruta: denegar por defecto (Fase 3.3)', () => {
  it('lee rutas públicas y protegidas', () => {
    expect(policy(Fixture, 'publicRoute')).toEqual({ kind: 'public', scope: 'tenant' });
    expect(policy(Fixture, 'protectedRoute')).toEqual({
      kind: 'protected',
      permission: 'members.read',
      operation: 'READ',
    });
    expect(policy(Fixture, 'authenticatedOnly')).toEqual({
      kind: 'protected',
      permission: null,
      operation: 'READ',
    });
  });

  it.each(['withoutOperation', 'withoutPermission', 'both', 'bare'])(
    'una ruta sin política completa (%s) es un error de configuración → 500',
    (method) => {
      expect(() => policy(Fixture, method)).toThrow(MissingRoutePolicyError);
      try {
        policy(Fixture, method);
      } catch (error) {
        expect((error as MissingRoutePolicyError).httpStatus).toBe(500);
      }
    },
  );

  it('@Public en la clase cubre sus métodos, pero un método que además declara permiso es un error', () => {
    expect(policy(PublicController, 'inherited')).toEqual({ kind: 'public', scope: 'none' });
    expect(() => policy(PublicController, 'overridden')).toThrow(MissingRoutePolicyError);
  });
});
