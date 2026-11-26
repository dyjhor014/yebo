import type { Metadata } from 'next';
import { TripDetailSection } from '@/components/panel/sections';

export const metadata: Metadata = { title: 'Viaje · Panel · YEBO', robots: { index: false } };

export default function Page() {
  return <TripDetailSection />;
}
