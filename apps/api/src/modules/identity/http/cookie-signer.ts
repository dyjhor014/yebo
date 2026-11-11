import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../../../config/env.module';
import { InvalidConfigurationError, type Env } from '../../../config/env';

/**
 * Firma HMAC-SHA256 de valores de cookie (`<valor>.<firma>`), con el propósito incluido en la firma para que
 * un valor firmado para un uso no sirva para otro. Clave: AUTH_COOKIE_SECRET (solo la exige el módulo identity).
 */
@Injectable()
export class CookieSigner {
  private readonly key: Buffer;

  constructor(@Inject(ENV) env: Env) {
    if (!env.AUTH_COOKIE_SECRET) {
      throw new InvalidConfigurationError(['AUTH_COOKIE_SECRET: obligatoria para el módulo de identidad']);
    }
    this.key = Buffer.from(env.AUTH_COOKIE_SECRET, 'utf8');
  }

  sign(purpose: string, value: string): string {
    if (value.includes('.')) throw new Error('El valor firmado no puede contener puntos');
    return `${value}.${this.mac(purpose, value)}`;
  }

  /** Devuelve el valor si la firma es válida para ese propósito; `null` en cualquier otro caso. */
  verify(purpose: string, signed: string | undefined): string | null {
    if (!signed || signed.length > 4096) return null;
    const index = signed.lastIndexOf('.');
    if (index <= 0) return null;
    const value = signed.slice(0, index);
    const given = Buffer.from(signed.slice(index + 1), 'base64url');
    const expected = Buffer.from(this.mac(purpose, value), 'base64url');
    return given.length === expected.length && timingSafeEqual(given, expected) ? value : null;
  }

  private mac(purpose: string, value: string): string {
    return createHmac('sha256', this.key).update(`yebo:${purpose}:v1|${value}`).digest('base64url');
  }
}
