import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NoAccess } from './no-access';

export const metadata: Metadata = { title: 'Tus empresas · YEBO', robots: { index: false } };

export default function NoAccessPage() {
  return (
    <Suspense>
      <NoAccess />
    </Suspense>
  );
}
