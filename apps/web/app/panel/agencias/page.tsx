import type { Metadata } from 'next';
import { AgenciesSection } from '@/components/panel/sections';

export const metadata: Metadata = { title: 'Agencias · Panel · YEBO', robots: { index: false } };

export default function Page() {
  return <AgenciesSection />;
}
