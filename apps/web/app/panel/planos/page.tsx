import type { Metadata } from 'next';
import { LayoutsSection } from '@/components/panel/sections';

export const metadata: Metadata = { title: 'Planos · Panel · YEBO', robots: { index: false } };

export default function Page() {
  return <LayoutsSection />;
}
