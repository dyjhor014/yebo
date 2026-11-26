import type { Metadata } from 'next';
import { SchedulesSection } from '@/components/panel/sections';

export const metadata: Metadata = { title: 'Programaciones · Panel · YEBO', robots: { index: false } };

export default function Page() {
  return <SchedulesSection />;
}
