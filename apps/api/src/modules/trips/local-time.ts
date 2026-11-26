/**
 * Hora local de la empresa ↔ instante (Fase 7.3). Las horas de los viajes llegan y salen como `AAAA-MM-DDTHH:mm` en la
 * zona horaria de la empresa y se guardan como `timestamptz`. Funciona con cualquier zona IANA (con o sin horario de
 * verano); una hora local que no existe (salto de verano) se corre hacia adelante.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Diferencia (ms) entre la hora local de la zona y UTC en ese instante. */
function offsetMs(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** `2026-12-01T08:30` en `America/Lima` → 2026-12-01T13:30:00Z. */
export function localToInstant(local: string, timeZone: string): Date {
  const wall = Date.parse(`${local}:00Z`);
  let instant = wall - offsetMs(wall, timeZone);
  // Segunda pasada: el desfase puede cambiar entre la estimación y el resultado (cambio de horario).
  instant = wall - offsetMs(instant, timeZone);
  return new Date(instant);
}

/** Instante → `AAAA-MM-DDTHH:mm` en la zona. */
export function instantToLocal(instant: Date, timeZone: string): string {
  const p = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** `AAAA-MM-DD` + n días. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
