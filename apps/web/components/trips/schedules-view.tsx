'use client';

import type { GenerateScheduleResponse, Route, Schedule, Weekday } from '@yebo/contracts';
import { Alert, Input, PRIMARY, SECONDARY, Select } from '@yebo/ui/form';
import Link from 'next/link';
import { useState } from 'react';
import {
  CARD,
  CARD_TITLE,
  Chip,
  Empty,
  LiveStatus,
  Loading,
  PAGE_BODY,
  PageHeader,
  fmtDate,
  today,
  useLoad,
} from '@/components/panel/kit';
import { usePanel } from '@/components/panel/panel-session';
import { routesApi, schedulesApi } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';
import { UnitFields, WEEKDAYS, fmtLongDay, loadFleet, type Fleet, type LayoutRef } from './trip-kit';

type Draft = {
  code: string;
  routeId: string;
  daily: boolean;
  weekdays: Weekday[];
  time: string;
  validFrom: string;
  validTo: string;
  excluded: string[];
  vehicleId: string | null;
  layout: LayoutRef;
};

const describe = (s: Schedule) =>
  s.recurrence.frequency === 'DAILY'
    ? 'todos los días'
    : WEEKDAYS.filter((d) => s.recurrence.frequency === 'WEEKLY' && s.recurrence.weekdays.includes(d.code))
        .map((d) => d.name.toLowerCase())
        .join(', ')
        .replace(/, ([^,]*)$/, ' y $1');

/**
 * Programaciones (Fase 7.5b; API de la 7.3b, maqueta 7.5 aprobada): días, hora, vigencia, fechas sin salida y unidad
 * por defecto. «Generar viajes» crea los que faltan hasta 60 días; cada día a las 00:30 se completan solas.
 */
export function SchedulesView() {
  const { can } = usePanel();
  const { data, error, reload } = useLoad(async () => {
    const [schedules, routes, fleet] = await Promise.all([
      schedulesApi.list(),
      routesApi.list(),
      loadFleet(can),
    ]);
    return { schedules: schedules.schedules, routes: routes.routes, fleet };
  });
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [rev, setRev] = useState(0);
  const [status, setStatus] = useState('');

  const schedules = data?.schedules ?? [];
  const activeRoutes = (data?.routes ?? []).filter((r) => !r.archived);
  const current =
    selected === 'new'
      ? null
      : (schedules.find((s) => s.id === selected) ?? (selected ? null : schedules[0]) ?? null);

  return (
    <>
      <PageHeader
        title="Programaciones"
        subtitle="Generan los viajes de los próximos 60 días. Cada día a las 00:30 se completan solas; también puedes generarlas ahora."
        actions={
          <button
            type="button"
            className={PRIMARY}
            disabled={!data || activeRoutes.length === 0}
            onClick={() => setSelected('new')}
          >
            Nueva programación
          </button>
        }
      />
      <LiveStatus message={status} />
      <div className={PAGE_BODY}>
        {error && <Alert>{error}</Alert>}
        {!data ? (
          !error && <Loading what="las programaciones" />
        ) : activeRoutes.length === 0 ? (
          <Empty>
            Para programar salidas, primero crea una ruta en{' '}
            <Link href="/panel/rutas" className="font-semibold underline underline-offset-4">
              Rutas
            </Link>
            .
          </Empty>
        ) : schedules.length === 0 && selected !== 'new' ? (
          <Empty>
            Aún no hay programaciones. Crea la primera con «Nueva programación»: por ejemplo, lunes y jueves a
            las 07:00.
          </Empty>
        ) : (
          <div className="flex flex-wrap items-start gap-5">
            <section
              aria-labelledby="h-schedules"
              className="flex min-w-0 flex-[1_1_18rem] flex-col rounded-xl border border-divider bg-raised lg:max-w-[24rem]"
            >
              <h2 id="h-schedules" className={`${CARD_TITLE} px-5 pt-4 pb-2`}>
                Programaciones
              </h2>
              <ul>
                {schedules.map((s) => {
                  const on = selected !== 'new' && s.id === current?.id;
                  return (
                    <li key={s.id} className="border-t border-divider">
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => setSelected(s.id)}
                        className={`flex min-h-16 w-full flex-col gap-0.5 px-5 py-2.5 text-left ${
                          on ? 'bg-action/10 shadow-[inset_0_0_0_2px_var(--text-primary)]' : 'hover:bg-ink/5'
                        }`}
                      >
                        <span className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-bold">
                          {s.code}
                          {s.archived && <Chip tone="none">Archivada</Chip>}
                        </span>
                        <span className="text-[0.8125rem] text-ink-muted">
                          {s.routeName} · {describe(s)} · {s.departureTime}
                        </span>
                        {s.generatedUntil && (
                          <span className="text-[0.8125rem] text-ink-muted">
                            Generada hasta el {fmtDate(s.generatedUntil)} (sin incluir)
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
            <ScheduleEditor
              key={`${current?.id ?? 'new'}:${rev}`}
              schedule={current}
              routes={activeRoutes}
              fleet={data.fleet}
              onSaved={async (s, message) => {
                await reload();
                setSelected(s.id);
                setRev((n) => n + 1);
                setStatus(message);
              }}
            />
          </div>
        )}
      </div>
    </>
  );
}

function ScheduleEditor({
  schedule,
  routes,
  fleet,
  onSaved,
}: {
  schedule: Schedule | null;
  routes: Route[];
  fleet: Fleet;
  onSaved: (s: Schedule, message: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    schedule
      ? {
          code: schedule.code,
          routeId: schedule.routeId,
          daily: schedule.recurrence.frequency === 'DAILY',
          weekdays: schedule.recurrence.frequency === 'WEEKLY' ? schedule.recurrence.weekdays : [],
          time: schedule.departureTime,
          validFrom: schedule.validFrom,
          validTo: schedule.validTo ?? '',
          excluded: schedule.excludedDates,
          vehicleId: schedule.vehicle?.id ?? null,
          layout: schedule.layout
            ? { layoutId: schedule.layout.layoutId, version: schedule.layout.version }
            : null,
        }
      : {
          code: '',
          routeId: routes[0]?.id ?? '',
          daily: false,
          weekdays: [],
          time: '07:00',
          validFrom: today(),
          validTo: '',
          excluded: [],
          vehicleId: null,
          layout: null,
        },
  );
  const [newDate, setNewDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateScheduleResponse | null>(null);
  const route = routes.find((r) => r.id === draft.routeId);
  const readOnly = schedule?.archived ?? false;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const fields = () => ({
    recurrence: draft.daily
      ? { frequency: 'DAILY' as const }
      : { frequency: 'WEEKLY' as const, weekdays: draft.weekdays },
    departureTime: draft.time,
    validFrom: draft.validFrom,
    validTo: draft.validTo || null,
    excludedDates: draft.excluded,
    vehicleId: draft.vehicleId,
    layout: draft.layout,
  });
  const save = () => {
    if (!draft.daily && draft.weekdays.length === 0) {
      setError('Elige al menos un día de la semana.');
      return Promise.resolve();
    }
    return run(async () => {
      const saved = schedule
        ? await schedulesApi.update(schedule.id, fields())
        : await schedulesApi.create({ code: draft.code, routeId: draft.routeId, ...fields() });
      await onSaved(saved, `Programación ${saved.code} ${schedule ? 'guardada' : 'creada'}`);
    });
  };
  const generate = () =>
    run(async () => {
      if (!schedule) return;
      const r = await schedulesApi.generate(schedule.id);
      setResult(r);
    });

  return (
    <section aria-labelledby="h-schedule" className="flex min-w-0 flex-[999_1_38rem] flex-col gap-4">
      <form
        className={CARD}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex flex-col gap-1">
            <h2 id="h-schedule" className="font-display text-xl font-extrabold">
              {schedule ? `${schedule.code} · ${schedule.routeName}` : 'Nueva programación'}
            </h2>
            <p className="text-sm text-ink-muted">
              El código y la ruta no cambian. Editarla no cambia los viajes ya generados.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {schedule && (
              <button
                type="button"
                className={SECONDARY}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const s = await (schedule.archived
                      ? schedulesApi.restore(schedule.id)
                      : schedulesApi.archive(schedule.id));
                    await onSaved(
                      s,
                      `Programación ${s.code} ${schedule.archived ? 'restaurada' : 'archivada'}`,
                    );
                  })
                }
              >
                {schedule.archived ? 'Restaurar' : 'Archivar'}
              </button>
            )}
            {!readOnly && (
              <button type="submit" className={schedule ? SECONDARY : PRIMARY} disabled={busy}>
                {schedule ? 'Guardar' : 'Crear programación'}
              </button>
            )}
            {schedule && !readOnly && (
              <button
                type="button"
                className={PRIMARY}
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => void generate()}
              >
                Generar viajes
              </button>
            )}
          </div>
        </div>
        {error && <Alert>{error}</Alert>}

        {!schedule && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Código"
              value={draft.code}
              onChange={(e) => set({ code: e.target.value.toUpperCase() })}
              hint="Ej.: PCL-LUN-JUE. No cambia después."
              maxLength={24}
              required
              autoComplete="off"
            />
            <Select
              label="Ruta"
              value={draft.routeId}
              onChange={(e) => set({ routeId: e.target.value, vehicleId: null, layout: null })}
            >
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code} · {r.name}
                </option>
              ))}
            </Select>
          </div>
        )}

        <fieldset className="flex flex-col gap-2" disabled={readOnly}>
          <legend className="pb-2 text-sm font-medium">Se repite</legend>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={draft.daily}
              onClick={() => set({ daily: true })}
              className={`min-h-11 rounded-[var(--radius-control)] px-3.5 text-sm font-semibold ${
                draft.daily ? 'bg-ink text-raised' : 'border border-control'
              }`}
            >
              Todos los días
            </button>
            <button
              type="button"
              aria-pressed={!draft.daily}
              onClick={() => set({ daily: false })}
              className={`min-h-11 rounded-[var(--radius-control)] px-3.5 text-sm font-semibold ${
                !draft.daily ? 'bg-ink text-raised' : 'border border-control'
              }`}
            >
              Algunos días
            </button>
            {!draft.daily && (
              <span className="flex flex-wrap gap-1.5" role="group" aria-label="Días de la semana">
                {WEEKDAYS.map((d) => {
                  const on = draft.weekdays.includes(d.code);
                  return (
                    <button
                      key={d.code}
                      type="button"
                      aria-pressed={on}
                      aria-label={d.name}
                      onClick={() =>
                        set({
                          weekdays: on
                            ? draft.weekdays.filter((x) => x !== d.code)
                            : [...draft.weekdays, d.code],
                        })
                      }
                      className={`size-11 rounded-full text-sm font-bold ${
                        on ? 'border-2 border-ink bg-action text-on-action' : 'border border-control'
                      }`}
                    >
                      {d.short}
                    </button>
                  );
                })}
              </span>
            )}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label="Hora de salida"
            type="time"
            value={draft.time}
            disabled={readOnly}
            onChange={(e) => set({ time: e.target.value })}
            required
          />
          <Input
            label="Desde"
            type="date"
            value={draft.validFrom}
            disabled={readOnly}
            onChange={(e) => set({ validFrom: e.target.value })}
            required
          />
          <Input
            label="Hasta (opcional)"
            type="date"
            value={draft.validTo}
            disabled={readOnly}
            onChange={(e) => set({ validTo: e.target.value })}
            hint="Ese día ya no sale."
          />
        </div>

        <div className="flex flex-col gap-2">
          <span id="lbl-ex" className="text-sm font-medium">
            Fechas sin salida
          </span>
          <ul aria-labelledby="lbl-ex" className="flex flex-wrap gap-2">
            {draft.excluded.map((d) => (
              <li
                key={d}
                className="inline-flex items-center gap-1 rounded-full bg-ink/8 py-1 pr-1 pl-3 text-sm"
              >
                {fmtLongDay(d)}
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={`Quitar el ${fmtLongDay(d)}`}
                    onClick={() => set({ excluded: draft.excluded.filter((x) => x !== d) })}
                    className="size-9 rounded-full hover:bg-ink/10"
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
            {draft.excluded.length === 0 && <li className="text-sm text-ink-muted">Ninguna</li>}
          </ul>
          {!readOnly && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-48">
                <Input
                  label="Fecha"
                  type="date"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                />
              </div>
              <button
                type="button"
                className={SECONDARY}
                disabled={!newDate}
                onClick={() => {
                  if (!draft.excluded.includes(newDate))
                    set({ excluded: [...draft.excluded, newDate].sort() });
                  setNewDate('');
                }}
              >
                Agregar fecha
              </button>
            </div>
          )}
        </div>

        {route && (
          <UnitFields
            modality={route.modality}
            fleet={fleet}
            vehicleId={draft.vehicleId}
            layout={draft.layout}
            onChange={(vehicleId, layout) => set({ vehicleId, layout })}
          />
        )}
        <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
          Si la unidad todavía está en otro viaje a la hora de una salida, ese viaje se crea sin unidad y te
          lo avisamos: asígnale otra desde Viajes.
        </p>
      </form>

      {result && (
        <section aria-labelledby="h-result" className={CARD}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="h-result" className={CARD_TITLE}>
              Resultado de generar
            </h3>
            <span className="text-[0.8125rem] text-ink-muted">
              Del {fmtDate(result.from)} al {fmtDate(result.until)} (sin incluir)
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Creados', result.created.length, 'bg-canvas'],
              ['Creados sin unidad', result.withoutUnit.length, 'bg-warning-surface'],
              ['Ya existían', result.existing, 'bg-canvas'],
              ['Omitidos', result.skipped.length, 'bg-canvas'],
            ].map(([label, n, bg]) => (
              <div
                key={label as string}
                className={`flex flex-col gap-0.5 rounded-[var(--radius-control)] p-3 ${bg as string}`}
              >
                <dt className="text-[0.8125rem]">{label}</dt>
                <dd className="font-display text-2xl font-extrabold">{n}</dd>
              </div>
            ))}
          </dl>
          {result.withoutUnit.length + result.skipped.length > 0 && (
            <ul className="flex flex-col">
              {[
                ...result.withoutUnit.map((w) => ({ ...w, kind: 'sin unidad' })),
                ...result.skipped.map((w) => ({ ...w, kind: 'omitido' })),
              ]
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((w) => (
                  <li
                    key={`${w.date}-${w.kind}`}
                    className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-divider py-2.5 text-sm"
                  >
                    <span>
                      <strong>{fmtLongDay(w.date)}</strong> · {w.kind}
                    </span>
                    <span className="text-ink-muted">{w.reason}</span>
                  </li>
                ))}
            </ul>
          )}
          <Link href="/panel/viajes" className="self-start font-semibold underline underline-offset-4">
            Ver los viajes
          </Link>
        </section>
      )}
    </section>
  );
}
