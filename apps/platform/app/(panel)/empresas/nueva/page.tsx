import type { Metadata } from 'next';
import { NewTenant } from './new-tenant';

export const metadata: Metadata = { title: 'Nueva empresa' };

export default function Page() {
  return <NewTenant />;
}
