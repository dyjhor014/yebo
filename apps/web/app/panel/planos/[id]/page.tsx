import type { Metadata } from 'next';
import { LayoutDetailSection } from '@/components/panel/sections';

export const metadata: Metadata = { title: 'Plano · Panel · YEBO', robots: { index: false } };

export default function Page() {
  return <LayoutDetailSection />;
}
