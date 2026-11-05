/**
 * ADR-025 · verificación estática: el contexto de tenant SOLO se fija con ámbito de transacción
 * (`set_config('app.tenant_id', …, true)` o `SET LOCAL`). Fijarlo a nivel de sesión haría que una
 * conexión reutilizada del pool heredara el tenant de un request anterior.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const API_ROOT = resolve(__dirname, '../../../..');
const SCANNED = ['src', 'test', 'prisma'];
const SELF = resolve(__filename);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'generated' || name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|sql)$/.test(name) && path !== SELF ? [path] : [];
  });
}

/** Elimina comentarios de línea para no confundir la documentación con código. */
const code = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/(^|\s)(\/\/|--|\*).*$/, ''))
    .join('\n');

describe('ADR-025 · el tenant se fija por transacción, nunca por sesión', () => {
  const sources = SCANNED.flatMap((d) => files(join(API_ROOT, d))).map((path) => ({
    path: relative(API_ROOT, path),
    text: code(readFileSync(path, 'utf8')),
  }));

  it('encuentra los puntos donde se fija el tenant (la verificación no está vacía)', () => {
    const setters = sources.filter((s) => s.text.includes("set_config('app.tenant_id'"));
    expect(setters.map((s) => s.path)).toEqual(
      expect.arrayContaining(['src/infrastructure/database/tenant-scope/tenant-scope.extension.ts']),
    );
  });

  it("todo set_config('app.tenant_id', …) usa is_local = true", () => {
    const offenders = sources.flatMap((s) =>
      [...s.text.matchAll(/set_config\(\s*'app\.tenant_id'\s*,([^()]|\([^()]*\))*?\)/g)]
        .filter((m) => !/,\s*true\s*\)$/.test(m[0]))
        .map((m) => `${s.path}: ${m[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no existe SET / SET SESSION de app.tenant_id (solo SET LOCAL)', () => {
    const offenders = sources.flatMap((s) =>
      [...s.text.matchAll(/\bSET\s+(SESSION\s+)?"?app\.tenant_id/gi)].map((m) => `${s.path}: ${m[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it('ninguna configuración de rol o base de datos fija app.tenant_id por defecto', () => {
    const offenders = sources.flatMap((s) =>
      [...s.text.matchAll(/ALTER\s+(ROLE|DATABASE|USER)[^;]*app\.tenant_id/gi)].map(
        (m) => `${s.path}: ${m[0]}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
