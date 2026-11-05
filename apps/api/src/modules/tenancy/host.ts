/**
 * Normaliza un host para buscarlo en tenant_domains. Devuelve null si no es un nombre de host válido:
 * así un valor arbitrario nunca llega a la base de datos ni a una clave de caché.
 */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeHost(raw: string | undefined): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  return host;
}
