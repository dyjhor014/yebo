import type { Metadata } from 'next';
import { FleetSection } from '@/components/panel/sections';

export const metadata: Metadata = { title: 'Flota · Panel · YEBO', robots: { index: false } };

export default function Page() {
  return <FleetSection />;
}
