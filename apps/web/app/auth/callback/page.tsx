import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Redeem } from './redeem';

export const metadata: Metadata = { title: 'Iniciando sesión · YEBO', robots: { index: false } };

export default function CallbackPage() {
  return (
    <Suspense>
      <Redeem />
    </Suspense>
  );
}
