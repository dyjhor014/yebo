/**
 * Formato del panel (Fase 4.7, crítica de Impeccable): importes es-PE (`S/ 1,338.50`) y fechas con año
 * (`15 nov 2026`). Se trabaja sobre las cadenas decimales de la API, sin pasar por float.
 */
const SYMBOL: Record<string, string> = { PEN: 'S/', USD: 'US$' };
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** `"1338.5"` → `"S/ 1,338.50"`. */
export function money(amount: string, currency = 'PEN'): string {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) throw new Error(`Importe no válido: ${amount}`);
  const [, sign, int = '0', dec = ''] = match;
  const grouped = int.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${SYMBOL[currency] ?? currency} ${grouped}.${dec.padEnd(2, '0')}`;
}

/** `"2026-11-15"` → `"15 nov 2026"`. */
export function date(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) throw new Error(`Fecha no válida: ${iso}`);
  const [, y, m, d] = match;
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Rango `[start, endExclusive)` de un período → `"1 – 30 nov 2026"` (o con ambos meses si difieren). */
export function period(start: string, endExclusive: string): string {
  const last = addDays(endExclusive, -1);
  const [sy, sm] = start.split('-');
  const [ly, lm] = last.split('-');
  if (sy === ly && sm === lm) return `${Number(start.slice(8, 10))} – ${date(last)}`;
  if (sy === ly) return `${date(start).replace(` ${sy}`, '')} – ${date(last)}`;
  return `${date(start)} – ${date(last)}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Fecha civil de hoy en la zona de la empresa (`YYYY-MM-DD`). */
export function today(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
}

/**
 * Importe escrito por el staff → cadena decimal con 2 decimales, o `null` si no es válido.
 * Acepta `204.00`, `204,00`, `1,338.50`, `S/ 204`. Nunca más de 2 decimales.
 */
export function parseAmount(text: string): string | null {
  let t = text
    .trim()
    .replace(/^S\/\s*/i, '')
    .replace(/\s/g, '');
  if (t.includes(',') && t.includes('.')) {
    if (!/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(t)) return null;
    t = t.replace(/,/g, '');
  } else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [int = '0', dec = ''] = t.split('.');
  const normal = `${int.replace(/^0+(?=\d)/, '')}.${dec.padEnd(2, '0')}`;
  return normal === '0.00' ? null : normal;
}

/** Compara cadenas decimales de 2 decimales sin float: −1, 0 o 1. */
export function compareAmounts(a: string, b: string): number {
  const cents = (x: string) => BigInt(x.replace('.', ''));
  const d = cents(a) - cents(b);
  return d === 0n ? 0 : d < 0n ? -1 : 1;
}

export function subtractAmounts(a: string, b: string): string {
  const cents = BigInt(a.replace('.', '')) - BigInt(b.replace('.', ''));
  const neg = cents < 0n;
  const abs = (neg ? -cents : cents).toString().padStart(3, '0');
  return `${neg ? '-' : ''}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}
