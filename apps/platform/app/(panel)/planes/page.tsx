import type { Metadata } from 'next';
import { PlanList } from './plan-list';

export const metadata: Metadata = { title: 'Planes' };

export default function Page() {
  return <PlanList />;
}
