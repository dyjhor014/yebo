'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { usePanel } from '@/components/panel/panel-session';

/** Inicio del panel: con «Mi sitio» lleva al editor; sin secciones aún, lo explica (el resto llega en otras fases). */
export function PanelHome() {
  const { company, can } = usePanel();
  const router = useRouter();
  const site = can('site.manage');
  useEffect(() => {
    if (site) router.replace('/panel/sitio');
  }, [site, router]);
  if (site) return <p className="px-6 py-10 text-ink-muted">Abriendo «Mi sitio»…</p>;
  return (
    <div className="flex max-w-2xl flex-col gap-3 px-4 py-8 sm:px-8 lg:px-12">
      <h1 className="font-display text-[1.625rem] font-extrabold tracking-[-0.02em]">
        Estás en {company.tenant.tradeName}
      </h1>
      <p className="text-ink-muted">
        Tu sesión está activa. Tu acceso todavía no incluye secciones del panel: pide a un administrador de la
        empresa los permisos que necesites.
      </p>
    </div>
  );
}
