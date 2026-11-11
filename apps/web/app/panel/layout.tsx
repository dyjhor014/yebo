import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PanelShell } from '@/components/panel/panel-shell';

export const metadata: Metadata = { title: 'Panel · YEBO', robots: { index: false } };

/** Panel de la empresa (Fase 5.4): exige sesión de la empresa del host; cada sección, su permiso. */
export default function PanelLayout({ children }: { children: ReactNode }) {
  return <PanelShell>{children}</PanelShell>;
}
