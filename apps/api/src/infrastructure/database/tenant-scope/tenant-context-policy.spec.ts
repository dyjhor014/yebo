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

/**
 * Elimina solo las líneas que son ENTERAMENTE comentario (`//`, `--`, `/*`, `*`).
 * No recorta dentro de una línea de código: `SELECT *` o `a - -b` no deben ocultar lo que sigue.
 * Un comentario al final de una línea de código se conserva: como mucho produce un falso positivo
 * (que se revisa), nunca un falso negativo.
 */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|--|\/\*|\*)/.test(line))
    .join('\n');

const sessionSetConfigs = (text: string) =>
  [...text.matchAll(/set_config\(\s*'app\.tenant_id'\s*,([^()]|\([^()]*\))*?\)/g)]
    .map((m) => m[0])
    .filter((call) => !/,\s*true\s*\)$/.test(call));
const sessionSets = (text: string) =>
  [...text.matchAll(/\bSET\s+(SESSION\s+)?"?app\.tenant_id/gi)].map((m) => m[0]);
const roleDefaults = (text: string) =>
  [...text.matchAll(/ALTER\s+(ROLE|DATABASE|USER)[^;]*app\.tenant_id/gi)].map((m) => m[0]);

describe('ADR-025 · el detector no tiene falsos negativos conocidos', () => {
  it('detecta set_config(…, false) en una línea con SELECT *', () => {
    const sample = `client.query("SELECT *, set_config('app.tenant_id', $1, false) FROM x")`;
    expect(sessionSetConfigs(code(sample))).toHaveLength(1);
  });

  it('detecta un SET de sesión después de una resta o de un comentario en la misma línea', () => {
    expect(sessionSets(code(`const n = a - -1; db.query('SET app.tenant_id = 1')`))).toHaveLength(1);
    expect(sessionSets(code(`db.query('SET SESSION app.tenant_id = 1') // ojo`))).toHaveLength(1);
  });

  it('ignora la documentación en líneas de comentario completas', () => {
    const docs = [
      "// set_config('app.tenant_id', x, false)",
      ' * SET app.tenant_id',
      '-- SET app.tenant_id',
    ].join('\n');
    expect(sessionSetConfigs(code(docs))).toEqual([]);
    expect(sessionSets(code(docs))).toEqual([]);
  });
});

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
    const offenders = sources.flatMap((s) => sessionSetConfigs(s.text).map((m) => `${s.path}: ${m}`));
    expect(offenders).toEqual([]);
  });

  it('no existe SET / SET SESSION de app.tenant_id (solo SET LOCAL)', () => {
    const offenders = sources.flatMap((s) => sessionSets(s.text).map((m) => `${s.path}: ${m}`));
    expect(offenders).toEqual([]);
  });

  it('ninguna configuración de rol o base de datos fija app.tenant_id por defecto', () => {
    const offenders = sources.flatMap((s) => roleDefaults(s.text).map((m) => `${s.path}: ${m}`));
    expect(offenders).toEqual([]);
  });
});
