import type { Metadata } from 'next';
import { SiteHistory } from '@/components/site-editor/site-history';

export const metadata: Metadata = { title: 'Historial del sitio · Panel · YEBO', robots: { index: false } };

export default function SiteHistoryPage() {
  return <SiteHistory />;
}
