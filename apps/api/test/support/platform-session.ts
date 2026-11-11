import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Sesión de staff de YEBO lista para usar en pruebas (Fase 4.x), sin pasar por el login con MFA (ya probado en
 * platform-auth.int-spec). Se crea con el rol EXCLUSIVO de pruebas: usuario ACTIVE con MFA activada y sesión vigente.
 */
export async function seedPlatformSession(
  seed: Pool,
  input: { email: string; role: 'SUPERADMIN' | 'BILLING' | 'SUPPORT' | 'VIEWER'; now: Date },
): Promise<{ platformUserId: string; cookie: string }> {
  const platformUserId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await seed.query(
    `INSERT INTO platform_users (id, email, full_name, password_hash, role, mfa_secret_ciphertext, mfa_key_version,
                                 mfa_enabled_at, updated_at)
     VALUES ($1, $2, $3, 'x', $4, '\\x00'::bytea, 1, $5, now())`,
    [platformUserId, input.email, input.email, input.role, input.now],
  );
  await seed.query(
    `INSERT INTO platform_sessions (id, platform_user_id, token_hash, last_seen_at, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, $4::timestamptz + interval '30 minutes', $4::timestamptz + interval '12 hours')`,
    [randomUUID(), platformUserId, createHash('sha256').update(token).digest(), input.now],
  );
  return {
    platformUserId,
    cookie: `__Host-yebo_admin=${encodeURIComponent(token)}; __Host-yebo_csrf=csrf-staff`,
  };
}

export const STAFF_CSRF = 'csrf-staff';
