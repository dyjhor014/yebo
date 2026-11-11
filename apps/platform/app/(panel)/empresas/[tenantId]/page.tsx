import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TenantFile } from './tenant-file';

export const metadata: Metadata = { title: 'Ficha de empresa' };

export default async function Page({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  return (
    <Suspense>
      <TenantFile tenantId={tenantId} />
    </Suspense>
  );
}
