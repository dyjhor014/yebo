import {
  TRACE_FILE_MAX_BYTES,
  inPeru,
  pathLengthKm,
  roundCoord,
  roundKm,
  simplifyPath,
  type LngLat,
  type TraceImportResponse,
} from '@yebo/contracts';
import { AppError } from '../../common/errors/app-error';

const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, 400);

/**
 * Lee la traza de un archivo GPX o KML (F7-Q9) sin un analizador XML general: un recorrido lineal de las etiquetas
 * que solo extrae coordenadas, así que no resuelve entidades, no sigue referencias externas y no ejecuta nada.
 * - Rechaza cualquier `<!DOCTYPE` o `<!ENTITY` (XXE y «mil millones de risas»): un GPX o KML real no los usa.
 * - Cada etiqueta, comentario o instrucción se recorre una vez (sin expresiones que retrocedan): un archivo hostil
 *   de 5 MB cuesta lo mismo que uno normal. Una etiqueta o un comentario sin cerrar es un archivo no válido.
 * - UTF-8 estricto, hasta 5 MB (TRACE_FILE_MAX_BYTES). KMZ (comprimido) no se admite: se exporta como KML.
 * - GPX: los puntos de las pistas (`trkpt`), en orden; si no hay, los de la ruta (`rtept`).
 * - KML: las coordenadas de las líneas (`LineString`) y de las pistas (`gx:coord`), en orden. Los puntos sueltos
 *   (`Point`, p. ej. marcadores de puerto) no son traza y se ignoran.
 * - Todos los puntos dentro del Perú. El resultado se simplifica a PATH_MAX_POINTS conservando la forma.
 */
export function importTrace(input: unknown): TraceImportResponse {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw invalid('Envía el archivo GPX o KML en el cuerpo');
  }
  if (input.length > TRACE_FILE_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'El archivo pesa más de 5 MB', 413);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(input);
  } catch {
    throw invalid('El archivo no está en UTF-8');
  }

  let format: 'GPX' | 'KML' | null = null;
  const trackPoints: LngLat[] = [];
  const routePoints: LngLat[] = [];
  const linePoints: LngLat[] = [];
  let lineDepth = 0;
  for (const tag of tags(text)) {
    if (format === null) {
      format = tag.name === 'gpx' && !tag.closing ? 'GPX' : tag.name === 'kml' && !tag.closing ? 'KML' : null;
      if (!format) throw invalid('El archivo no es un GPX ni un KML');
      continue;
    }
    if (format === 'GPX') {
      if (tag.closing) continue;
      if (tag.name === 'trkpt') trackPoints.push(gpxPoint(tag.attributes));
      else if (tag.name === 'rtept') routePoints.push(gpxPoint(tag.attributes));
      continue;
    }
    if (tag.name === 'LineString' && !tag.selfClosing) lineDepth += tag.closing ? -1 : 1;
    else if (!tag.closing && tag.name === 'coordinates' && lineDepth > 0) {
      for (const tuple of tag.text.trim().split(/\s+/).filter(Boolean)) {
        const [lng, lat] = tuple.split(',');
        linePoints.push([coordinate(lng, 'longitud'), coordinate(lat, 'latitud')]);
      }
    } else if (!tag.closing && tag.name === 'coord' && tag.prefix === 'gx') {
      const [lng, lat] = tag.text.trim().split(/\s+/);
      linePoints.push([coordinate(lng, 'longitud'), coordinate(lat, 'latitud')]);
    }
  }
  if (!format) throw invalid('El archivo no es un GPX ni un KML');

  const raw = format === 'GPX' ? (trackPoints.length > 0 ? trackPoints : routePoints) : linePoints;
  if (raw.length < 2) {
    throw invalid(
      format === 'GPX'
        ? 'El GPX no trae una pista ni una ruta con al menos 2 puntos'
        : 'El KML no trae una línea con al menos 2 puntos',
    );
  }
  const outside = raw.filter((p) => !inPeru(p)).length;
  if (outside > 0) {
    throw invalid(
      `${outside === 1 ? 'Un punto está' : `${outside} puntos están`} fuera del Perú: revisa el archivo`,
    );
  }
  const points = simplifyPath(raw.map(([lng, lat]): LngLat => [roundCoord(lng), roundCoord(lat)]));
  if (points.length < 2) throw invalid('La traza no tiene al menos 2 puntos distintos');
  return { format, points, sourcePoints: raw.length, km: roundKm(pathLengthKm(points)) };
}

interface Tag {
  prefix: string | null;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: string;
  /** Texto entre esta etiqueta y la siguiente. */
  text: string;
}

const TAG_NAME = /^(\/?)(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)/;

/** Recorre las etiquetas una sola vez, saltando comentarios, CDATA e instrucciones de procesamiento. */
function* tags(text: string): Generator<Tag> {
  let pos = 0;
  for (;;) {
    const lt = text.indexOf('<', pos);
    if (lt < 0) return;
    const skip = (open: string, close: string, what: string): number | null => {
      if (!text.startsWith(open, lt)) return null;
      const end = text.indexOf(close, lt + open.length);
      if (end < 0) throw invalid(`El archivo tiene ${what} sin cerrar`);
      return end + close.length;
    };
    const skipped =
      skip('<!--', '-->', 'un comentario') ??
      skip('<![CDATA[', ']]>', 'un bloque CDATA') ??
      skip('<?', '?>', 'una instrucción');
    if (skipped !== null) {
      pos = skipped;
      continue;
    }
    if (text.startsWith('<!', lt))
      throw invalid('El archivo declara un DOCTYPE o entidades, y no se admiten');
    const gt = text.indexOf('>', lt);
    if (gt < 0) throw invalid('El archivo tiene una etiqueta sin cerrar');
    const body = text.slice(lt + 1, gt);
    const m = TAG_NAME.exec(body);
    if (!m) throw invalid('El archivo no es XML válido');
    const next = text.indexOf('<', gt + 1);
    yield {
      prefix: m[2] ?? null,
      name: m[3] as string,
      closing: m[1] === '/',
      selfClosing: body.endsWith('/'),
      attributes: body.slice(m[0].length),
      text: text.slice(gt + 1, next < 0 ? text.length : next),
    };
    pos = gt + 1;
  }
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function coordinate(value: string | undefined, label: string): number {
  if (value === undefined || !NUMBER.test(value.trim()))
    throw invalid(`Hay una ${label} que no es un número`);
  return Number(value);
}

/** Valor de un atributo (`lat="…"` o `lat='…'`), sin expresiones que retrocedan. */
function attribute(attributes: string, name: string): string | undefined {
  for (const m of attributes.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (m[1] === name) return m[2] ?? m[3];
  }
  return undefined;
}

function gpxPoint(attributes: string): LngLat {
  return [
    coordinate(attribute(attributes, 'lon'), 'longitud'),
    coordinate(attribute(attributes, 'lat'), 'latitud'),
  ];
}
