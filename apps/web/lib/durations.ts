/**
 * Duraciones de las rutas (Fase 7.5a): los minutos desde la salida y los de parada se escriben como se dicen
 * («12 h», «1 d 12 h», «90 min», «2 h 15 min», «12:30») y se guardan en minutos.
 */

const UNIT: Record<string, number> = { d: 1440, h: 60, m: 1, min: 1 };

/** Minutos de una duración escrita a mano, o null si no se entiende. Un número solo son horas. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/,/g, '.');
  if (t === '') return null;
  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(t);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60);
  const parts = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|min|m)(?=\s|\d|$)/g)];
  // Todo el texto tiene que estar hecho de partes reconocidas (sin restos sueltos).
  if (parts.length === 0 || t.replace(/(\d+(?:\.\d+)?)\s*(d|h|min|m)(?=\s|\d|$)/g, '').trim() !== '')
    return null;
  return Math.round(parts.reduce((sum, p) => sum + Number(p[1]) * (UNIT[p[2] as string] ?? 0), 0));
}

/** «1 d 12 h», «12 h 30 min», «45 min», «0 min». */
export function formatDuration(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const out = [d && `${d} d`, h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ');
  return out || '0 min';
}

/** «día 2 · +1 d 12 h» desde la salida del origen (el día 1 es el de la salida). */
export function dayOf(minutes: number): number {
  return Math.floor(minutes / 1440) + 1;
}
