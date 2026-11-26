/**
 * Archivos del mapa propio (Fase 7.6, M-Q2): el PMTiles del Perú, sus fuentes y sus sprites, servidos por el mismo
 * origen desde `YEBO_MAP_DIR`. En producción los sirve Nginx; esta lógica es la de la ruta de Next (desarrollo y
 * E2E). Sin dependencias de Node para poder probarla sola.
 */

/** Tipos permitidos por extensión: nada más se sirve. */
export const MAP_TYPES: Record<string, string> = {
  pmtiles: 'application/vnd.pmtiles',
  pbf: 'application/x-protobuf',
  json: 'application/json',
  png: 'image/png',
};

/** Un segmento seguro: letras, dígitos, espacio, `@`, `_`, `-` y puntos que no formen `..`. */
const SEGMENT = /^[A-Za-z0-9 @_.-]{1,80}$/;

/**
 * Ruta relativa dentro del directorio del mapa a partir de los segmentos de la URL, o null si no es un archivo del
 * mapa (segmento raro, `..`, archivo oculto o extensión no permitida).
 */
export function mapFilePath(segments: readonly string[]): { path: string; type: string } | null {
  if (segments.length === 0 || segments.length > 4) return null;
  for (const s of segments) {
    if (!SEGMENT.test(s) || s.startsWith('.') || s.includes('..')) return null;
  }
  const name = segments[segments.length - 1]!;
  const type = MAP_TYPES[name.split('.').pop()?.toLowerCase() ?? ''];
  if (!type || !name.includes('.')) return null;
  return { path: segments.join('/'), type };
}

export type ByteRange = { start: number; end: number };

/**
 * Cabecera `Range` de un solo rango en bytes (lo que pide el lector de PMTiles): `bytes=a-b`, `bytes=a-` o
 * `bytes=-n` (los últimos n). Null sin cabecera; `'unsatisfiable'` si no se puede servir (→ 416).
 */
export function parseRange(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  if (header === null || header.trim() === '') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'unsatisfiable';
  if (size === 0) return 'unsatisfiable';
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}
