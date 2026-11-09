import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Política de contraseñas al FIJAR una contraseña (phase-3-plan; Fase 4.3b, decisión del 2026-11-10):
 * - entre 10 y 128 caracteres;
 * - no está en la lista local de contraseñas filtradas (sin llamadas externas; ver data/README.md);
 * - no contiene el correo, su parte local, las palabras del nombre (4+ letras) ni «yebo».
 * Devuelve el motivo del rechazo (para mostrarlo a la persona) o `null`.
 */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

let common: ReadonlySet<string> | null = null;

/** Carga perezosa: la lista solo se descomprime la primera vez que alguien fija una contraseña. */
function commonPasswords(): ReadonlySet<string> {
  if (!common) {
    const raw = gunzipSync(readFileSync(join(__dirname, 'data', 'common-passwords.txt.gz'))).toString('utf8');
    common = new Set(raw.split('\n').filter((l) => l.length > 0));
  }
  return common;
}

export function passwordProblem(
  password: string,
  context: { email: string; fullName?: string },
): string | null {
  if (password.length < PASSWORD_MIN) return `Usa al menos ${PASSWORD_MIN} caracteres`;
  if (password.length > PASSWORD_MAX) return `Usa como mucho ${PASSWORD_MAX} caracteres`;
  const lower = password.toLowerCase();
  if (commonPasswords().has(lower)) return 'Esa contraseña aparece en filtraciones conocidas: elige otra';
  const email = context.email.trim().toLowerCase();
  const local = email.split('@')[0] ?? '';
  const words = (context.fullName ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
  const plain = lower.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  if (
    lower.includes(email) ||
    (local.length >= 4 && lower.includes(local)) ||
    words.some((w) => plain.includes(w)) ||
    lower.includes('yebo')
  ) {
    return 'La contraseña no puede contener tu correo, tu nombre ni «yebo»';
  }
  return null;
}
