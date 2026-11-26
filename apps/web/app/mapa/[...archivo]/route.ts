import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { mapFilePath, parseRange } from '@/lib/map-files';

/**
 * Mapa propio en el mismo origen (Fase 7.6, M-Q2): `/mapa/peru.pmtiles` (por rangos), `/mapa/fuentes/…` y
 * `/mapa/sprites/…`, leídos de `YEBO_MAP_DIR`. En producción lo sirve Nginx con el mismo camino; esta ruta es para
 * desarrollo y el E2E. Sin el directorio o sin el archivo: 404, y las pantallas siguen sin mapa (M-Q7).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ archivo: string[] }> };

async function serve(req: Request, ctx: Ctx, head: boolean): Promise<Response> {
  const root = process.env.YEBO_MAP_DIR;
  const file = mapFilePath((await ctx.params).archivo.map((s) => decodeURIComponent(s)));
  if (!root || !file) return new Response(null, { status: 404 });
  const base = resolve(root);
  const full = resolve(base, file.path);
  if (!full.startsWith(base + sep)) return new Response(null, { status: 404 });

  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) return new Response(null, { status: 404 });

  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = new Headers({
    'Content-Type': file.type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  const range = parseRange(req.headers.get('range'), info.size);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = range ?? { start: 0, end: info.size - 1 };
  headers.set('Content-Length', String(info.size === 0 ? 0 : end - start + 1));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
  const status = range ? 206 : 200;
  if (head || info.size === 0) return new Response(null, { status, headers });
  const stream = Readable.toWeb(createReadStream(full, { start, end })) as ReadableStream;
  return new Response(stream, { status, headers });
}

export function GET(req: Request, ctx: Ctx) {
  return serve(req, ctx, false);
}

export function HEAD(req: Request, ctx: Ctx) {
  return serve(req, ctx, true);
}
