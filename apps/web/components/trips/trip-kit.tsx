'use client';

import type { Layout, Modality, TripStatus, Vehicle } from '@yebo/contracts';
import { Select } from '@yebo/ui/form';
import type { ChipTone } from '@/components/panel/kit';
import { fleetApi, layoutsApi } from '@/lib/panel-api';

/** Piezas comunes de Viajes y Programaciones (Fase 7.5b, maqueta 7.5 aprobada). */

export const TRIP_STATUS: Record<TripStatus, { label: string; tone: ChipTone }> = {
  PLANNED: { label: 'Planificado', tone: 'none' },
  OPEN_FOR_SALE: { label: 'A la venta', tone: 'ok' },
  CONFIRMED: { label: 'Confirmado', tone: 'ok' },
  BOARDING: { label: 'Embarcando', tone: 'ok' },
  DEPARTED: { label: 'En viaje', tone: 'ok' },
  ARRIVED: { label: 'Llegó', tone: 'none' },
  CLOSED: { label: 'Cerrado', tone: 'none' },
  CANCELLED: { label: 'Cancelado', tone: 'bad' },
};

const DAY = new Intl.DateTimeFormat('es-PE', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const LONG_DAY = new Intl.DateTimeFormat('es-PE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

/** «AAAA-MM-DDTHH:mm» local de la empresa → «lun. 23 nov. 07:00». */
export function fmtLocal(local: string): string {
  return `${DAY.format(new Date(`${local.slice(0, 10)}T00:00:00Z`))} ${local.slice(11, 16)}`;
}

/** «AAAA-MM-DD» → «Lunes 23 de noviembre». */
export function fmtLongDay(date: string): string {
  const s = LONG_DAY.format(new Date(`${date}T00:00:00Z`));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `AAAA-MM-DD` + n días. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Lunes de la semana de la fecha. */
export function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

export const WEEKDAYS = [
  { code: 'MO', short: 'L', name: 'Lunes' },
  { code: 'TU', short: 'M', name: 'Martes' },
  { code: 'WE', short: 'X', name: 'Miércoles' },
  { code: 'TH', short: 'J', name: 'Jueves' },
  { code: 'FR', short: 'V', name: 'Viernes' },
  { code: 'SA', short: 'S', name: 'Sábado' },
  { code: 'SU', short: 'D', name: 'Domingo' },
] as const;

// ---------------------------------------------------------------------------------------------------------------
// Unidad y plano (viajes y programaciones)
// ---------------------------------------------------------------------------------------------------------------

export type Fleet = { vehicles: Vehicle[] | null; layouts: Layout[] | null };

/** La flota y los planos, si el permiso alcanza (sin él, solo «Sin unidad» y el plano asignado). */
export async function loadFleet(can: (p: string) => boolean): Promise<Fleet> {
  const [vehicles, layouts] = await Promise.all([
    can('fleet.manage') ? fleetApi.vehicles().then((r) => r.vehicles) : Promise.resolve(null),
    can('layouts.manage') ? layoutsApi.list().then((r) => r.layouts) : Promise.resolve(null),
  ]);
  return { vehicles, layouts };
}

export type LayoutRef = { layoutId: string; version: number } | null;
const refValue = (r: LayoutRef) => (r ? `${r.layoutId}:${r.version}` : '');

/** Unidad (de la modalidad de la ruta, no retirada) y plano (el asignado ese día o una versión publicada). */
export function UnitFields({
  modality,
  fleet,
  vehicleId,
  layout,
  onChange,
}: {
  modality: Modality;
  fleet: Fleet;
  vehicleId: string | null;
  layout: LayoutRef;
  onChange: (vehicleId: string | null, layout: LayoutRef) => void;
}) {
  const vehicles = (fleet.vehicles ?? []).filter((v) => v.modality === modality && v.status !== 'RETIRED');
  const versions = (fleet.layouts ?? [])
    .filter((l) => l.modality === modality && !l.archived)
    .flatMap((l) =>
      l.versions
        .filter((v) => v.status === 'PUBLISHED')
        .map((v) => ({
          value: refValue({ layoutId: l.id, version: v.version }),
          label: `${l.name} · versión ${v.version}`,
        })),
    );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Select
        label="Unidad (opcional)"
        value={vehicleId ?? ''}
        onChange={(e) => onChange(e.target.value || null, e.target.value ? layout : null)}
        hint={
          fleet.vehicles === null ? 'Tu acceso no incluye la flota: el viaje queda sin unidad.' : undefined
        }
      >
        <option value="">Sin unidad</option>
        {vehicles.map((v) => (
          <option key={v.id} value={v.id}>
            {v.code} · {v.name}
          </option>
        ))}
      </Select>
      <Select
        label="Plano"
        value={refValue(layout)}
        disabled={!vehicleId}
        onChange={(e) => {
          const [id, version] = e.target.value.split(':');
          onChange(vehicleId, id ? { layoutId: id, version: Number(version) } : null);
        }}
      >
        <option value="">El asignado a la unidad cada día</option>
        {versions.map((v) => (
          <option key={v.value} value={v.value}>
            {v.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
