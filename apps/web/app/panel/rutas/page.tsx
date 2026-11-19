import type { Metadata } from 'next';
import { RoutesSection } from '@/components/panel/sections';

export const metadata: Metadata = { title: 'Rutas · Panel · YEBO', robots: { index: false } };

export default function Page() {
  return <RoutesSection />;
}
