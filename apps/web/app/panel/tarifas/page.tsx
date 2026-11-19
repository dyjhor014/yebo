import type { Metadata } from 'next';
import { FaresSection } from '@/components/panel/sections';

export const metadata: Metadata = { title: 'Tarifas · Panel · YEBO', robots: { index: false } };

export default function Page() {
  return <FaresSection />;
}
