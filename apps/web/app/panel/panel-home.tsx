'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { usePanel } from '@/components/panel/panel-session';
import { SECTIONS, canOpen } from '@/components/panel/panel-shell';

/** Inicio del panel: lleva a la primera sección permitida; sin ninguna, lo explica. */
export function PanelHome() {
  const { company, can, hasModule } = usePanel();
  const router = useRouter();
  const first = SECTIONS.find((s) => canOpen(s, can, hasModule));
  useEffect(() => {
    if (first) router.replace(first.href);
  }, [first, router]);
  if (first) return <p className="px-6 py-10 text-ink-muted">Abriendo «{first.label}»…</p>;
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
