import type { Metadata } from 'next';
import { InspectionSection } from '@/components/panel/sections';

export const metadata: Metadata = { title: 'Inspección · Panel · YEBO', robots: { index: false } };

export default function Page() {
  return <InspectionSection />;
}
