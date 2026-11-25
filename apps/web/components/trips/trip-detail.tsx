'use client';

import {
  INSPECTION_DISCLAIMER,
  type BlockReason,
  type Trip,
  type TripAvailability,
  type TripBlock,
  type TripInspectionsResponse,
} from '@yebo/contracts';
import { Dialog } from '@yebo/ui/dialog';
import { Alert, Input, PRIMARY, SECONDARY, ScrollRegion, Select, Textarea, Warning } from '@yebo/ui/form';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  CARD,
  CARD_TITLE,
  Chip,
  DialogActions,
  Empty,
  LiveStatus,
  Loading,
  PAGE_BODY,
  ROW_ACTION,
  fmtNumber,
  useLoad,
} from '@/components/panel/kit';
import { usePanel } from '@/components/panel/panel-session';
import { tripsApi } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';
import { TRIP_STATUS, UnitFields, fmtLocal, loadFleet, type LayoutRef } from './trip-kit';

const REASON: Record<BlockReason, string> = {
  CREW: 'Tripulación',
  MAINTENANCE: 'Mantenimiento',
  COURTESY: 'Cortesía',
  OTHER: 'Otro',
};
const DIMENSION: Record<string, string> = {
  PERSONS: 'personas',
  UNITS: 'unidades',
  WEIGHT_KG: 'kg',
  VOLUME_M3: 'm³',
  LINEAR_M: 'm lineales',
};
const RESULT: Record<string, { label: string; tone: 'ok' | 'warn' }> = {
  COMPLETED: { label: 'Completada', tone: 'ok' },
  COMPLETED_WITH_OBSERVATIONS: { label: 'Con observaciones', tone: 'warn' },
};

/** «2A» antes que «10A». */
const NATURAL = new Intl.Collator('es', { numeric: true });

type PoolRow = TripAvailability['pools'][number];
const poolName = (p: Pick<PoolRow, 'scope' | 'zoneCode' | 'dimension'>) =>
  p.scope === 'VEHICLE'
    ? 'Aforo de la unidad · personas'
    : `Zona ${p.zoneCode} · ${DIMENSION[p.dimension] ?? p.dimension}`;

type Data = {
  trip: Trip;
  availability: TripAvailability | null;
  blocks: TripBlock[] | null;
  inspections: TripInspectionsResponse | null;
};

/**
 * Ficha del viaje (Fase 7.5b, maqueta 7.5 aprobada): itinerario con horas locales, unidad y plano, estados (abrir a
 * la venta, volver a planificado, cancelar), disponibilidad por tramo (recursos y cupos), bloqueos operativos y el
 * control preoperacional, que es opcional y solo informa.
 */
export function TripDetail({ id }: { id: string }) {
  const { can } = usePanel();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [seg, setSeg] = useState(0);
  const [dialog, setDialog] = useState<'cancel' | 'edit' | 'block' | null>(null);

  const load = useCallback(async () => {
    try {
      const trip = await tripsApi.get(id);
      const [availability, blocks, inspections] = await Promise.all([
        trip.inventory ? tripsApi.availability(id) : Promise.resolve(null),
        can('trips.block') ? tripsApi.blocks(id).then((r) => r.blocks) : Promise.resolve(null),
        can('inspections.read') ? tripsApi.inspections(id) : Promise.resolve(null),
      ]);
      setData({ trip, availability, blocks, inspections });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id, can]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await load();
      setStatus(message);
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return <div className={PAGE_BODY}>{error ? <Alert>{error}</Alert> : <Loading what="el viaje" />}</div>;
  }
  const { trip, availability, blocks, inspections } = data;
  const first = trip.stops[0];
  const last = trip.stops[trip.stops.length - 1];
  const active = (blocks ?? []).filter((b) => b.state !== 'RELEASED');
  const segments = availability?.segments ?? [];
  const zones = [...new Set((availability?.resources ?? []).map((r) => r.zoneCode))];

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-divider bg-raised px-4 py-5 sm:px-8 lg:px-10">
        <div className="flex flex-col gap-1.5">
          <Link href="/panel/viajes" className="text-sm font-semibold underline underline-offset-4">
            ← Viajes
          </Link>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="font-display text-[1.625rem] font-extrabold tracking-[-0.02em]">
              {first?.locationName} → {last?.locationName} · {fmtLocal(trip.departureLocal)}
            </h1>
            <Chip tone={TRIP_STATUS[trip.status].tone}>{TRIP_STATUS[trip.status].label}</Chip>
          </div>
          <p className="text-sm text-ink-muted">
            {trip.code} · {trip.departureKind === 'SCHEDULED' ? 'de una programación' : 'viaje puntual'}
            {trip.cancelReason && ` · cancelado: ${trip.cancelReason}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-2">
          {trip.status === 'PLANNED' && (
            <>
              <button type="button" className={SECONDARY} disabled={busy} onClick={() => setDialog('edit')}>
                Editar
              </button>
              <button
                type="button"
                className={PRIMARY}
                disabled={busy}
                onClick={() => void act(() => tripsApi.open(id), 'Viaje abierto a la venta')}
              >
                Abrir a la venta
              </button>
            </>
          )}
          {trip.status === 'OPEN_FOR_SALE' && (
            <button
              type="button"
              className={SECONDARY}
              disabled={busy}
              aria-describedby={active.length ? 'why-fixed' : undefined}
              onClick={() => void act(() => tripsApi.backToPlanned(id), 'Viaje de vuelta a planificado')}
            >
              Volver a planificado
            </button>
          )}
          {(trip.status === 'PLANNED' || trip.status === 'OPEN_FOR_SALE') && (
            <button
              type="button"
              className={`${SECONDARY} border-danger text-danger`}
              disabled={busy}
              onClick={() => setDialog('cancel')}
            >
              Cancelar viaje
            </button>
          )}
        </div>
      </header>
      {trip.status === 'OPEN_FOR_SALE' && (
        <p id="why-fixed" className="bg-warning-surface px-4 py-2.5 text-sm sm:px-8 lg:px-10">
          {active.length > 0
            ? `Tiene ${active.length} ${active.length === 1 ? 'bloqueo activo' : 'bloqueos activos'}: para volver a planificado o cancelar, libéralos antes. `
            : ''}
          La unidad, el plano y las horas quedan fijos mientras está a la venta.
        </p>
      )}
      <LiveStatus message={status} />
      <div className={`${PAGE_BODY} max-w-[90rem]`}>
        {actionError && <Alert>{actionError}</Alert>}
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-4 lg:max-w-[25rem]">
            <section aria-labelledby="h-itin" className={CARD}>
              <h2 id="h-itin" className={CARD_TITLE}>
                Itinerario
              </h2>
              <ol className="flex flex-col">
                {trip.stops.map((s, i) => (
                  <li key={s.seq} className="grid grid-cols-[1.125rem_1fr] gap-3 py-2">
                    <span aria-hidden="true" className="mt-1 size-3.5 rounded-full bg-ink" />
                    <span className="flex flex-col gap-0.5">
                      <span className="font-bold">{s.locationName}</span>
                      <span className="text-[0.8125rem] text-ink-muted">
                        {i === 0
                          ? `Sale ${fmtLocal(s.departureLocal ?? trip.departureLocal)}`
                          : s.departureLocal
                            ? `Llega ${fmtLocal(s.arrivalLocal ?? '')} · sale ${(s.departureLocal ?? '').slice(11, 16)}`
                            : `Llega ${fmtLocal(s.arrivalLocal ?? '')}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            <section aria-labelledby="h-unit" className={CARD}>
              <h2 id="h-unit" className={CARD_TITLE}>
                Unidad y plano
              </h2>
              {trip.vehicle ? (
                <>
                  <p className="text-[0.9375rem] font-semibold">
                    {trip.vehicle.code} · {trip.vehicle.name}
                  </p>
                  <p className="text-sm text-ink-muted">
                    {trip.layout
                      ? `${trip.layout.name} · versión ${trip.layout.version}`
                      : 'Sin plano: no se puede abrir a la venta.'}
                  </p>
                  {trip.inventory && (
                    <p className="text-sm text-ink-muted">
                      {trip.inventory.sellableResources} lugares asignables ·{' '}
                      {trip.inventory.pools.map((p) => `${poolName(p)} ${fmtNumber(p.capacity)}`).join(' · ')}
                    </p>
                  )}
                </>
              ) : (
                <Empty>Sin unidad. Asígnale una con «Editar» para poder abrir la venta.</Empty>
              )}
            </section>

            {inspections && (
              <section aria-labelledby="h-pre" className={CARD}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id="h-pre" className={CARD_TITLE}>
                    Control preoperacional
                  </h2>
                  <span className="text-[0.8125rem] text-ink-muted">Opcional</span>
                </div>
                {inspections.latestForVehicle ? (
                  <div className="flex flex-col gap-1.5 rounded-[var(--radius-control)] bg-canvas p-3">
                    <span className="text-[0.8125rem] text-ink-muted">
                      Última inspección de {inspections.latestForVehicle.vehicleCode}
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <Chip tone={RESULT[inspections.latestForVehicle.status]?.tone ?? 'none'}>
                        {RESULT[inspections.latestForVehicle.status]?.label ?? 'Borrador'}
                      </Chip>
                      <span className="text-sm font-semibold">
                        {fmtLocal(
                          isoToLocal(
                            inspections.latestForVehicle.completedAt ??
                              inspections.latestForVehicle.startedAt,
                          ),
                        )}{' '}
                        ·{' '}
                        {inspections.latestForVehicle.completedBy?.name ??
                          inspections.latestForVehicle.startedBy.name ??
                          'Una persona de la empresa'}
                      </span>
                    </span>
                    {inspections.latestForVehicle.counts && (
                      <span className="text-sm">
                        {inspections.latestForVehicle.counts.conforming} conformes ·{' '}
                        {inspections.latestForVehicle.counts.observed} observados ·{' '}
                        {inspections.latestForVehicle.counts.notOperational +
                          inspections.latestForVehicle.counts.notAvailable}{' '}
                        no operativos o no disponibles
                      </span>
                    )}
                    <span className="text-[0.8125rem] text-ink-muted">
                      {inspections.latestForVehicle.trip?.id === trip.id
                        ? 'Hecha para este viaje'
                        : 'Sin relación con este viaje'}
                    </span>
                  </div>
                ) : (
                  <p className="text-sm text-ink-muted">
                    {trip.vehicle
                      ? 'La unidad aún no tiene inspecciones en el sistema.'
                      : 'Asigna una unidad para ver sus inspecciones.'}
                  </p>
                )}
                <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
                  No bloquea la venta ni la salida. {INSPECTION_DISCLAIMER}
                </p>
              </section>
            )}
          </div>

          <div className="flex min-w-0 flex-[999_1_36rem] flex-col gap-4">
            <section aria-labelledby="h-avail" className={CARD}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="h-avail" className={CARD_TITLE}>
                  Disponibilidad por tramo
                </h2>
                <span className="text-[0.8125rem] text-ink-muted">
                  Un pasaje de A a B ocupa los tramos entre ambos
                </span>
              </div>
              {!availability ? (
                <Empty>Sin plano todavía: la disponibilidad aparece al asignar una unidad con plano.</Empty>
              ) : (
                <>
                  <div role="group" aria-label="Tramo" className="flex flex-wrap gap-2">
                    {segments.map((s) => (
                      <button
                        key={s.seq}
                        type="button"
                        aria-pressed={s.seq === seg}
                        onClick={() => setSeg(s.seq)}
                        className={`min-h-11 rounded-[var(--radius-control)] px-3.5 text-sm font-semibold ${
                          s.seq === seg ? 'border-2 border-ink bg-ink text-raised' : 'border border-control'
                        }`}
                      >
                        {s.from} → {s.to}
                      </button>
                    ))}
                  </div>
                  {zones.map((z) => {
                    const items = availability.resources
                      .filter((r) => r.zoneCode === z)
                      .sort((a, b) => NATURAL.compare(a.code, b.code));
                    const free = items.filter((r) => r.free[seg]).length;
                    return (
                      <div key={z} className="flex flex-col gap-2">
                        <h3 className="text-[0.9375rem] font-bold">
                          Zona {z} · {free} de {items.length} libres
                        </h3>
                        <ul
                          aria-label={`Lugares de la zona ${z} en el tramo elegido`}
                          className="flex flex-wrap gap-1.5"
                        >
                          {items.map((r) => (
                            <li
                              key={r.code}
                              className={`flex min-h-9 min-w-12 items-center justify-center rounded-md px-2 text-xs font-bold ${
                                r.free[seg] ? 'border border-control bg-raised' : 'bg-rail text-on-rail'
                              }`}
                            >
                              <span>
                                {r.code}
                                <span className="sr-only">{r.free[seg] ? ' libre' : ' ocupado'}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem]">
                    <span>
                      <span
                        aria-hidden="true"
                        className="mr-1 inline-block size-3.5 rounded border border-control align-[-2px]"
                      />{' '}
                      libre
                    </span>
                    <span>
                      <span
                        aria-hidden="true"
                        className="mr-1 inline-block size-3.5 rounded bg-rail align-[-2px]"
                      />{' '}
                      ocupado o bloqueado
                    </span>
                  </p>
                  {availability.pools.length > 0 && (
                    <ScrollRegion label="Cupos por tramo">
                      <table className="w-full min-w-[36rem] border-collapse text-sm">
                        <caption className="sr-only">Cupos por cantidad, libres en cada tramo</caption>
                        <thead>
                          <tr className="bg-canvas text-left">
                            <th scope="col" className="px-3 py-2.5 font-semibold">
                              Cupo
                            </th>
                            {segments.map((s) => (
                              <th key={s.seq} scope="col" className="px-3 py-2.5 font-semibold">
                                {s.from} → {s.to}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {availability.pools.map((p) => (
                            <tr key={p.id} className="border-t border-divider">
                              <th scope="row" className="px-3 py-2.5 text-left font-semibold">
                                {poolName(p)}
                              </th>
                              {p.free.map((f, i) => (
                                <td key={i} className="px-3 py-2.5">
                                  {fmtNumber(f)} de {fmtNumber(p.capacity)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </ScrollRegion>
                  )}
                </>
              )}
            </section>

            {blocks && (
              <section aria-labelledby="h-blocks" className={CARD}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="h-blocks" className={CARD_TITLE}>
                    Bloqueos
                  </h2>
                  {trip.status === 'OPEN_FOR_SALE' && availability && (
                    <button type="button" className={PRIMARY} onClick={() => setDialog('block')}>
                      Nuevo bloqueo
                    </button>
                  )}
                </div>
                {blocks.length === 0 ? (
                  <Empty>
                    {trip.status === 'OPEN_FOR_SALE'
                      ? 'Sin bloqueos. Reserva lugares o cupos para la tripulación, mantenimiento o cortesía.'
                      : 'Los bloqueos se hacen con el viaje a la venta.'}
                  </Empty>
                ) : (
                  <ul className="flex flex-col">
                    {blocks.map((b) => {
                      const from = trip.stops[b.fromSeq]?.locationName;
                      const to = trip.stops[b.toSeq]?.locationName;
                      const what = [
                        b.resourceCodes.length ? b.resourceCodes.join(', ') : null,
                        ...b.pools.map((p) => {
                          const pool = availability?.pools.find((x) => x.id === p.poolId);
                          return `${fmtNumber(p.quantity)} en ${pool ? poolName(pool) : 'un cupo'}`;
                        }),
                      ]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <li
                          key={b.id}
                          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-divider py-3"
                        >
                          <span className="flex flex-col gap-0.5">
                            <span className="text-[0.9375rem] font-bold">
                              {REASON[b.reason]} · {what}
                            </span>
                            <span className="text-[0.8125rem] text-ink-muted">
                              {from} → {to}
                              {b.note && ` · «${b.note}»`}
                            </span>
                          </span>
                          {b.state === 'ACTIVE' ? (
                            <button
                              type="button"
                              className={ROW_ACTION}
                              disabled={busy}
                              aria-label={`Liberar el bloqueo de ${REASON[b.reason].toLowerCase()}: ${what}`}
                              onClick={() => void act(() => tripsApi.release(id, b.id), 'Bloqueo liberado')}
                            >
                              Liberar
                            </button>
                          ) : (
                            <Chip tone="none">{b.state === 'RELEASED' ? 'Liberado' : 'Vencido'}</Chip>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}
          </div>
        </div>
      </div>

      {dialog === 'cancel' && (
        <CancelDialog
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            setDialog(null);
            await act(() => tripsApi.cancel(id, reason), 'Viaje cancelado');
          }}
        />
      )}
      {dialog === 'edit' && (
        <EditDialog
          trip={trip}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null);
            await load();
            setStatus('Viaje guardado');
          }}
        />
      )}
      {dialog === 'block' && availability && (
        <BlockDialog
          trip={trip}
          availability={availability}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null);
            await load();
            setStatus('Bloqueo creado');
          }}
        />
      )}
    </>
  );
}

/** Instante ISO → «AAAA-MM-DDTHH:mm» en Lima (las fechas de inspección llegan como instantes). */
function isoToLocal(iso: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function CancelDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title="Cancelar viaje"
      description="Es definitivo: un viaje cancelado no vuelve a abrirse ni se genera de nuevo."
      onRequestClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void onConfirm(reason.trim());
        }}
      >
        <Textarea
          label="Motivo"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={3}
          maxLength={300}
          rows={3}
        />
        <DialogActions busy={busy} label="Cancelar el viaje" onCancel={onClose} />
      </form>
    </Dialog>
  );
}

function EditDialog({
  trip,
  onClose,
  onSaved,
}: {
  trip: Trip;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { can } = usePanel();
  const fleet = useLoad(() => loadFleet(can));
  const [date, setDate] = useState(trip.departureLocal.slice(0, 10));
  const [time, setTime] = useState(trip.departureLocal.slice(11, 16));
  const [vehicleId, setVehicleId] = useState<string | null>(trip.vehicle?.id ?? null);
  const [layout, setLayout] = useState<LayoutRef>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await tripsApi.update(trip.id, {
        departureLocal: `${date}T${time}`,
        vehicleId,
        layout,
        minPassengers: trip.minPassengers,
        confirmationDeadlineLocal: trip.confirmationDeadlineLocal,
      });
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Editar viaje"
      description="Mover la salida corre las horas de todas las paradas. El plano, si no eliges otro, es el asignado a la unidad ese día."
      onRequestClose={onClose}
      wide
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Fecha de salida"
            type="date"
            value={date}
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
        {fleet.data && (
          <UnitFields
            modality={trip.modality}
            fleet={fleet.data}
            vehicleId={vehicleId}
            layout={layout}
            onChange={(v, l) => {
              setVehicleId(v);
              setLayout(l);
            }}
          />
        )}
        <DialogActions busy={busy} label="Guardar cambios" onCancel={onClose} />
      </form>
    </Dialog>
  );
}

function BlockDialog({
  trip,
  availability,
  onClose,
  onSaved,
}: {
  trip: Trip;
  availability: TripAvailability;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const n = trip.stops.length;
  const [reason, setReason] = useState<BlockReason>('CREW');
  const [note, setNote] = useState('');
  const [fromSeq, setFrom] = useState(0);
  const [toSeq, setTo] = useState(n - 1);
  const [codes, setCodes] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const resourceCodes = [
      ...new Set(
        codes
          .split(/[\s,;]+/)
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    const pools = Object.entries(qty)
      .map(([poolId, q]) => ({ poolId, quantity: Number(q.replace(',', '.')) }))
      .filter((p) => p.quantity > 0);
    if (resourceCodes.length === 0 && pools.length === 0) {
      setError('Indica al menos un lugar o una cantidad de un cupo.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await tripsApi.block(trip.id, {
        reason,
        note: note.trim() || null,
        fromSeq,
        toSeq,
        resourceCodes,
        pools,
        expiresAt: null,
      });
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Nuevo bloqueo"
      description="Reserva lugares o cupos entre dos paradas. Si algo ya está ocupado, no se bloquea nada."
      onRequestClose={onClose}
      wide
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Motivo" value={reason} onChange={(e) => setReason(e.target.value as BlockReason)}>
            {(Object.keys(REASON) as BlockReason[]).map((r) => (
              <option key={r} value={r}>
                {REASON[r]}
              </option>
            ))}
          </Select>
          <Select
            label="Desde"
            value={fromSeq}
            onChange={(e) => {
              const v = Number(e.target.value);
              setFrom(v);
              if (toSeq <= v) setTo(v + 1);
            }}
          >
            {trip.stops.slice(0, -1).map((s) => (
              <option key={s.seq} value={s.seq}>
                {s.locationName}
              </option>
            ))}
          </Select>
          <Select label="Hasta" value={toSeq} onChange={(e) => setTo(Number(e.target.value))}>
            {trip.stops.slice(fromSeq + 1).map((s) => (
              <option key={s.seq} value={s.seq}>
                {s.locationName}
              </option>
            ))}
          </Select>
        </div>
        <Input
          label="Lugares (opcional)"
          value={codes}
          onChange={(e) => setCodes(e.target.value)}
          hint="Códigos separados por comas, p. ej. 1A, 1B o C1 (un camarote ocupa todas sus camas)."
          autoComplete="off"
        />
        {availability.pools.length > 0 && (
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-medium">Cantidades en cupos (opcional)</legend>
            {availability.pools.map((p) => (
              <Input
                key={p.id}
                label={poolName(p)}
                inputMode="decimal"
                value={qty[p.id] ?? ''}
                onChange={(e) => setQty((x) => ({ ...x, [p.id]: e.target.value }))}
              />
            ))}
          </fieldset>
        )}
        <Input
          label="Nota (opcional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
        />
        {n > 2 && (
          <Warning>
            El bloqueo ocupa los tramos entre «Desde» y «Hasta»: en «Hasta» el lugar queda libre.
          </Warning>
        )}
        <DialogActions busy={busy} label="Bloquear" onCancel={onClose} />
      </form>
    </Dialog>
  );
}
