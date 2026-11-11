import type { Metadata } from 'next';
import { LocationsSection } from '@/components/panel/sections';

export const metadata: Metadata = { title: 'Ubicaciones · Panel · YEBO', robots: { index: false } };

export default function Page() {
  return <LocationsSection />;
}
