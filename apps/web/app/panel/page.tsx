import type { Metadata } from 'next';
import { SessionPanel } from './session-panel';

export const metadata: Metadata = { title: 'Panel · YEBO', robots: { index: false } };

export default function PanelPage() {
  return <SessionPanel />;
}
