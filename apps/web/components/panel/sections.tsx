'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { AgenciesView } from '@/components/agencies/agencies-view';
import { FaresView } from '@/components/fares/fares-view';
import { FleetView } from '@/components/fleet/fleet-view';
import { LayoutDetail } from '@/components/layouts/layout-detail';
import { LayoutsView } from '@/components/layouts/layouts-view';
import { LocationsView } from '@/components/locations/locations-view';
import { RoutesView } from '@/components/routes/routes-view';
import { SchedulesView } from '@/components/trips/schedules-view';
import { TripDetail } from '@/components/trips/trip-detail';
import { TripsView } from '@/components/trips/trips-view';
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

/** Agencias externas (Fase 6.5b): además del permiso, la empresa necesita el módulo AGENCIES, que activa YEBO. */
export function AgenciesSection() {
  const { hasModule } = usePanel();
  return (
    <Guard permission="agencies.manage">
      {hasModule('AGENCIES') ? (
        <AgenciesView />
      ) : (
        <p className="px-4 py-10 text-ink-muted sm:px-8 lg:px-10">
          Tu empresa aún no tiene el módulo de agencias externas. Si quieres vender por agencias, pídelo a
          YEBO.
        </p>
      )}
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

/** Rutas (Fase 7.5a): paradas en orden, tiempos y trazas. */
export function RoutesSection() {
  return (
    <Guard permission="routes.manage">
      <RoutesView />
    </Guard>
  );
}

/** Tarifas (Fase 7.5a): matriz tramo × clase con vigencias. */
export function FaresSection() {
  return (
    <Guard permission="fares.manage">
      <FaresView />
    </Guard>
  );
}

/** Viajes (Fase 7.5b): agenda semanal por día. */
export function TripsSection() {
  return (
    <Guard permission="trips.manage">
      <TripsView />
    </Guard>
  );
}

/** Ficha del viaje (Fase 7.5b): itinerario, disponibilidad por tramo, bloqueos y control preoperacional. */
export function TripDetailSection() {
  const { id } = useParams<{ id: string }>();
  return (
    <Guard permission="trips.manage">
      <TripDetail id={id} />
    </Guard>
  );
}

/** Programaciones (Fase 7.5b): generan los viajes hasta 60 días. */
export function SchedulesSection() {
  return (
    <Guard permission="trips.manage">
      <SchedulesView />
    </Guard>
  );
}
