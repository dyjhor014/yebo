import type { Metadata } from 'next';
import { TripsSection } from '@/components/panel/sections';

export const metadata: Metadata = { title: 'Viajes · Panel · YEBO', robots: { index: false } };

export default function Page() {
  return <TripsSection />;
}
