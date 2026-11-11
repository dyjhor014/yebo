import type { Metadata } from 'next';
import { SiteEditor } from '@/components/site-editor/site-editor';

export const metadata: Metadata = { title: 'Mi sitio · Panel · YEBO', robots: { index: false } };

export default function SitePage() {
  return <SiteEditor />;
}
