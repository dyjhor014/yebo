/**
 * Subdominios reservados (MKT-D6, MKT-01 §2.3): ningún tenant puede registrarlos como slug. La lista aprobada más los
 * nombres internos identificados; las etiquetas del hub (`AUTH_HUB_HOST`) y del panel (`PLATFORM_ADMIN_HOST`) se
 * añaden siempre desde la configuración. Ampliar la lista no afecta a los tenants existentes.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  // MKT-D6 (aprobados)
  'www',
  'app',
  'cuentas',
  'admin',
  'api',
  'blog',
  'ayuda',
  'docs',
  'estado',
  'status',
  'mail',
  'demo',
  'static',
  // Nombres internos y de infraestructura
  'yebo',
  'empresas',
  'auth',
  'login',
  'panel',
  'soporte',
  'support',
  'help',
  'cdn',
  'assets',
  'media',
  'files',
  'webmail',
  'smtp',
  'imap',
  'pop',
  'mx',
  'ns1',
  'ns2',
  'dev',
  'staging',
  'preprod',
  'test',
  'sandbox',
  'beta',
  'internal',
  'metrics',
  'grafana',
]);

/** Etiqueta de un host de la plataforma relativa al dominio base (`cuentas.yebo.pe` → `cuentas`). */
export function platformLabel(host: string, baseDomain: string): string | null {
  const suffix = `.${baseDomain}`;
  return host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
}

/** ¿Está reservado este slug? Considera la lista fija y las etiquetas de los hosts de la plataforma. */
export function isReservedSlug(slug: string, platformHosts: readonly string[], baseDomain: string): boolean {
  const normalized = slug.trim().toLowerCase();
  if (RESERVED_SUBDOMAINS.has(normalized)) return true;
  return platformHosts.some((h) => platformLabel(h, baseDomain) === normalized);
}
