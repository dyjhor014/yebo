'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { FleetView } from '@/components/fleet/fleet-view';
import { LayoutDetail } from '@/components/layouts/layout-detail';
import { LayoutsView } from '@/components/layouts/layouts-view';
import { LocationsView } from '@/components/locations/locations-view';
import { usePanel } from './panel-session';

/** Sin el permiso de la sección: lo explica (la API también lo rechaza). */
function Guard({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = usePanel();
  if (can(permission)) return <>{children}</>;
  return (
    <p className="px-4 py-10 text-ink-muted sm:px-8 lg:px-10">
      Tu acceso no incluye esta sección: pide a un administrador de la empresa el permiso que necesitas.
    </p>
  );
}

export function LocationsSection() {
  return (
    <Guard permission="locations.manage">
      <LocationsView />
    </Guard>
  );
}

export function FleetSection() {
  const { can } = usePanel();
  return (
    <Guard permission="fleet.manage">
      <FleetView canLayouts={can('layouts.manage')} />
    </Guard>
  );
}

export function LayoutsSection() {
  const { company } = usePanel();
  const modalities = [...new Set(company.services.map((s) => s.modality))].filter(
    (m): m is 'RIVER' | 'LAND' => m === 'RIVER' || m === 'LAND',
  );
  return (
    <Guard permission="layouts.manage">
      <LayoutsView modalities={modalities} />
    </Guard>
  );
}

export function LayoutDetailSection() {
  const { id } = useParams<{ id: string }>();
  return (
    <Guard permission="layouts.manage">
      <LayoutDetail id={id} />
    </Guard>
  );
}
