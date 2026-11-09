import type { Metadata } from 'next';
import { Suspense } from 'react';
import { StaffLogin } from './staff-login';

export const metadata: Metadata = { title: 'Iniciar sesión' };

export default function Page() {
  return (
    <Suspense>
      <StaffLogin />
    </Suspense>
  );
}
