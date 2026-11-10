import { siteAssetUrl } from '@yebo/contracts';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Portal } from '@/components/portal/portal';
import { resolveHost } from '@/lib/public-site';

export const dynamic = 'force-dynamic';

/** Metadatos del portal: nombre de la empresa, subtítulo y favicon generado de su logo. */
export async function generateMetadata(): Promise<Metadata> {
  const host = await resolveHost();
  if (host.kind !== 'tenant') return { title: 'YEBO' };
  const { tenant, site } = host.site;
  const logo = site.config.logoAssetId;
  return {
    title: tenant.tradeName,
    description: site.config.hero.subtitle || `${tenant.tradeName}: servicios, sucursales y contacto.`,
    ...(logo && { icons: { icon: siteAssetUrl(logo, 'favicon') } }),
    ...(site.config.hero.imageAssetId && {
      openGraph: { images: [siteAssetUrl(site.config.hero.imageAssetId)], title: tenant.tradeName },
    }),
  };
}

/** Raíz de cada host: portal de la empresa; en el hub de cuentas, el login; host desconocido → 404. */
export default async function Home() {
  const host = await resolveHost();
  if (host.kind === 'hub') redirect('/login');
  if (host.kind === 'unknown') notFound();
  return <Portal site={host.site} />;
}
