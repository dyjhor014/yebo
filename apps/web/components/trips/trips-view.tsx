'use client';

import type { Route, Trip, TripStatus } from '@yebo/contracts';
import { Dialog } from '@yebo/ui/dialog';
import { Alert, Input, PRIMARY, SECONDARY, Select } from '@yebo/ui/form';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Chip,
  DialogActions,
  Empty,
  Loading,
  PAGE_BODY,
  PageHeader,
  fmtDate,
  today,
  useLoad,
} from '@/components/panel/kit';
import { usePanel } from '@/components/panel/panel-session';
import { routesApi, tripsApi } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';
import {
  TRIP_STATUS,
  UnitFields,
  addDays,
  fmtLocal,
  fmtLongDay,
  loadFleet,
  mondayOf,
  type LayoutRef,
} from './trip-kit';

/**
 * Viajes (Fase 7.5b; API de la 7.3a, maqueta 7.5 aprobada): agenda semanal por día, con filtros por ruta y estado,
 * y el viaje puntual. La ficha de cada viaje muestra su disponibilidad por tramo, sus bloqueos y su control
 * preoperacional.
 */
export function TripsView() {
  const { can } = usePanel();
  const [week, setWeek] = useState(() => mondayOf(today()));
  const [routeId, setRouteId] = useState('');
  const [status, setStatusFilter] = useState<TripStatus | ''>('');
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const routes = useLoad(async () => (await routesApi.list()).routes);

  useEffect(() => {
    let live = true;
    setTrips(null);
    setError(null);
    tripsApi
      .list({ from: week, to: addDays(week, 6), routeId: routeId || undefined, status: status || undefined })
      .then((r) => live && setTrips(r.trips))
      .catch((e: unknown) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [week, routeId, status]);

  const days = [...new Set((trips ?? []).map((t) => t.departureLocal.slice(0, 10)))];
  const withoutUnit = (trips ?? []).filter((t) => !t.vehicle && t.status !== 'CANCELLED').length;
  const activeRoutes = (routes.data ?? []).filter((r) => !r.archived);

  return (
    <>
      <PageHeader
        title="Viajes"
        subtitle={
          trips
            ? `Semana del ${fmtDate(week)} al ${fmtDate(addDays(week, 6))} · ${trips.length} ${
                trips.length === 1 ? 'viaje' : 'viajes'
              }${withoutUnit ? ` · ${withoutUnit} sin unidad` : ''}`
            : 'Salidas de la semana, por día.'
        }
        actions={
          <button
            type="button"
            className={PRIMARY}
            disabled={activeRoutes.length === 0}
            onClick={() => setCreating(true)}
          >
            Nuevo viaje
          </button>
        }
      />
      <div className={PAGE_BODY}>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={SECONDARY}
              aria-label="Semana anterior"
              onClick={() => setWeek(addDays(week, -7))}
            >
              ‹
            </button>
            <span className="min-w-48 text-center text-[0.9375rem] font-bold" aria-live="polite">
              {fmtDate(week)} – {fmtDate(addDays(week, 6))}
            </span>
            <button
              type="button"
              className={SECONDARY}
              aria-label="Semana siguiente"
              onClick={() => setWeek(addDays(week, 7))}
            >
              ›
            </button>
          </div>
          <div className="min-w-56">
            <Select label="Ruta" value={routeId} onChange={(e) => setRouteId(e.target.value)}>
              <option value="">Todas las rutas</option>
              {(routes.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code} · {r.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-44">
            <Select
              label="Estado"
              value={status}
              onChange={(e) => setStatusFilter(e.target.value as TripStatus | '')}
            >
              <option value="">Todos</option>
              <option value="PLANNED">Planificado</option>
              <option value="OPEN_FOR_SALE">A la venta</option>
              <option value="CANCELLED">Cancelado</option>
            </Select>
          </div>
        </div>
        {error && <Alert>{error}</Alert>}
        {!trips ? (
          !error && <Loading what="los viajes" />
        ) : trips.length === 0 ? (
          <Empty>
            No hay viajes esta semana con esos filtros. Crea uno con «Nuevo viaje» o genera los de una{' '}
            <Link href="/panel/programaciones" className="font-semibold underline underline-offset-4">
              programación
            </Link>
            .
          </Empty>
        ) : (
          days.map((day) => (
            <section
              key={day}
              aria-labelledby={`d-${day}`}
              className="rounded-xl border border-divider bg-raised"
            >
              <h2 id={`d-${day}`} className="px-5 py-3.5 font-display text-base font-extrabold">
                {fmtLongDay(day)}
              </h2>
              <ul>
                {trips
                  .filter((t) => t.departureLocal.startsWith(day))
                  .map((t) => (
                    <li key={t.id} className="border-t border-divider">
                      <Link
                        href={`/panel/viajes/${t.id}`}
                        className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 py-3 hover:bg-ink/5 lg:grid lg:grid-cols-[4.5rem_minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)]"
                      >
                        <span
                          className={`font-display text-lg font-extrabold ${t.status === 'CANCELLED' ? 'text-ink-muted line-through' : ''}`}
                        >
                          {t.departureLocal.slice(11, 16)}
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[0.9375rem] font-bold">
                            {t.stops[0]?.locationName} → {t.stops[t.stops.length - 1]?.locationName}
                          </span>
                          <span className="text-[0.8125rem] text-ink-muted">
                            {t.code} · {t.departureKind === 'SCHEDULED' ? 'programado' : 'puntual'} · llega{' '}
                            {fmtLocal(t.arrivalLocal)}
                          </span>
                        </span>
                        <span className={`text-sm ${t.vehicle ? '' : 'font-semibold text-warning'}`}>
                          {t.vehicle ? `${t.vehicle.code} · ${t.vehicle.name}` : 'Sin unidad'}
                        </span>
                        <span>
                          <Chip tone={TRIP_STATUS[t.status].tone}>{TRIP_STATUS[t.status].label}</Chip>
                        </span>
                      </Link>
                    </li>
                  ))}
              </ul>
            </section>
          ))
        )}
        <p className="text-[0.8125rem] text-ink-muted">
          Los días sin viajes no se muestran. Un viaje cancelado no vuelve a generarse desde su programación.
        </p>
      </div>
      {creating && <NewTripDialog routes={activeRoutes} can={can} onClose={() => setCreating(false)} />}
    </>
  );
}

function NewTripDialog({
  routes,
  can,
  onClose,
}: {
  routes: Route[];
  can: (p: string) => boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const fleet = useLoad(() => loadFleet(can));
  const [routeId, setRouteId] = useState(routes[0]?.id ?? '');
  const [date, setDate] = useState(addDays(today(), 1));
  const [time, setTime] = useState('07:00');
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutRef>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const route = routes.find((r) => r.id === routeId);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await tripsApi.create({
        routeId,
        departureLocal: `${date}T${time}`,
        vehicleId,
        layout,
        minPassengers: null,
        confirmationDeadlineLocal: null,
      });
      router.push(`/panel/viajes/${t.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Nuevo viaje"
      description="Un viaje puntual. Copia las paradas de la ruta con sus horas; la ruta puede cambiar después sin afectarlo."
      onRequestClose={onClose}
      wide
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        {error && <Alert>{error}</Alert>}
        <Select
          label="Ruta"
          value={routeId}
          onChange={(e) => {
            setRouteId(e.target.value);
            setVehicleId(null);
            setLayout(null);
          }}
        >
          {routes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.code} · {r.name}
            </option>
          ))}
        </Select>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Fecha de salida"
            type="date"
            value={date}
            min={today()}
            onChange={(e) => setDate(e.target.value)}
            required
          />
          <Input
            label="Hora de salida"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            required
          />
        </div>
        {route && fleet.data && (
          <UnitFields
            modality={route.modality}
            fleet={fleet.data}
            vehicleId={vehicleId}
            layout={layout}
            onChange={(v, l) => {
              setVehicleId(v);
              setLayout(l);
            }}
          />
        )}
        <DialogActions busy={busy} label="Crear viaje" onCancel={onClose} />
      </form>
    </Dialog>
  );
}
