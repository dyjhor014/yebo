import type { Metadata } from 'next';
import { TenantList } from './tenant-list';

export const metadata: Metadata = { title: 'Empresas' };

export default function Page() {
  return <TenantList />;
}
