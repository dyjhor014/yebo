import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../../config/env.module';
import { InvalidConfigurationError, type Env } from '../../config/env';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedField {
  /** IV (12 bytes) ‖ etiqueta GCM (16 bytes) ‖ texto cifrado. */
  ciphertext: Buffer;
  keyVersion: number;
}

/**
 * Cifrado de campo (ADR-019; security.md §4): AES-256-GCM con IV aleatorio y `key_version` junto al dato, para
 * poder rotar la clave sin descifrar todo a la vez. El AAD liga el texto cifrado a su fila y a su columna
 * (p. ej., `platform_users.mfa_secret:<id>`): copiado a otra fila, no se descifra.
 *
 * Rotación: hoy solo existe la clave vigente (FIELD_ENCRYPTION_KEY + _VERSION). Cuando haga falta rotar se
 * añadirán las claves anteriores para descifrar; un dato con una versión desconocida falla cerrado.
 */
@Injectable()
export class FieldEncryption {
  private readonly key: Buffer;
  private readonly version: number;

  constructor(@Inject(ENV) env: Env) {
    if (!env.FIELD_ENCRYPTION_KEY) {
      throw new InvalidConfigurationError([
        'FIELD_ENCRYPTION_KEY: obligatoria para el cifrado de campo (ADR-019)',
      ]);
    }
    this.key = Buffer.from(env.FIELD_ENCRYPTION_KEY, 'base64');
    this.version = env.FIELD_ENCRYPTION_KEY_VERSION;
  }

  encrypt(plaintext: Buffer, aad: string): EncryptedField {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]), keyVersion: this.version };
  }

  /** Devuelve el texto plano o lanza si la clave, el AAD o el dato no coinciden (nunca devuelve basura). */
  decrypt(field: EncryptedField, aad: string): Buffer {
    if (field.keyVersion !== this.version)
      throw new Error(`Versión de clave desconocida: ${field.keyVersion}`);
    if (field.ciphertext.length < IV_BYTES + TAG_BYTES) throw new Error('Texto cifrado truncado');
    const iv = field.ciphertext.subarray(0, IV_BYTES);
    const tag = field.ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(field.ciphertext.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
  }
}
