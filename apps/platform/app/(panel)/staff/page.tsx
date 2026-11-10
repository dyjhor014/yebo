import type { Metadata } from 'next';
import { StaffList } from './staff-list';

export const metadata: Metadata = { title: 'Staff de YEBO' };

export default function Page() {
  return <StaffList />;
}
