'use client';

import {
  CreateRouteRequestSchema,
  ROUTE_MAX_STOPS,
  UpdateRouteRequestSchema,
  distanceKm,
  pathLengthKm,
  roundKm,
  type LngLat,
  type Location,
  type Modality,
  type Route,
} from '@yebo/contracts';
import { Alert, Input, PRIMARY, SECONDARY, ScrollRegion, Select, Warning } from '@yebo/ui/form';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MODALITY_NAME } from '@/components/fleet/fleet-view';
import {
  CARD,
  CARD_TITLE,
  Chip,
  Empty,
  LiveStatus,
  Loading,
  PAGE_BODY,
  PageHeader,
  ROW_ACTION,
  fmtNumber,
  useLoad,
} from '@/components/panel/kit';
import { usePanel } from '@/components/panel/panel-session';
import { dayOf, formatDuration, parseDuration } from '@/lib/durations';
import { importTrace, locationsApi, routesApi } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';

const TH = 'px-3 py-2.5 text-left text-[0.8125rem] font-semibold text-ink-muted';
const TD = 'px-3 py-2.5 align-top text-sm';
const SMALL_INPUT =
  'min-h-11 w-28 rounded-[var(--radius-control)] border border-control bg-raised px-2.5 text-[0.9375rem] text-ink';

type StopDraft = {
  key: string;
  locationId: string;
  offset: string;
  dwell: string;
  allowsBoarding: boolean;
  allowsAlighting: boolean;
  pathToNext: LngLat[] | null;
};

type Draft = {
  id: string | null;
  code: string;
  name: string;
  modality: Modality;
  archived: boolean;
  stops: StopDraft[];
};

let keySeq = 0;
const newKey = () => `p${++keySeq}`;

const emptyStop = (): StopDraft => ({
  key: newKey(),
  locationId: '',
  offset: '',
  dwell: '0 min',
  allowsBoarding: true,
  allowsAlighting: true,
  pathToNext: null,
});

const toDraft = (r: Route): Draft => ({
  id: r.id,
  code: r.code,
  name: r.name,
  modality: r.modality,
  archived: r.archived,
  stops: r.stops.map((s) => ({
    key: newKey(),
    locationId: s.locationId,
    offset: formatDuration(s.offsetMinutes),
    dwell: formatDuration(s.dwellMinutes),
    allowsBoarding: s.allowsBoarding,
    allowsAlighting: s.allowsAlighting,
    pathToNext: s.pathToNext as LngLat[] | null,
  })),
});

const loadAll = async () => {
  const [routes, locations] = await Promise.all([routesApi.list(), locationsApi.list()]);
  return { routes: routes.routes, locations: locations.locations, kinds: locations.kinds };
};

/**
 * Rutas (Fase 7.5a; API de la 7.1, maqueta 7.5 aprobada): lista y editor de paradas en orden. El tiempo se cuenta
 * desde la salida del origen; las paradas se mueven con sus botones o con Alt + flechas. Cada tramo puede llevar una
 * traza importada de un GPX o KML; sin ella, los km son en línea recta. El mapa llega con la 7.6.
 */
export function RoutesView() {
  const { company } = usePanel();
  const { data, error, reload } = useLoad(loadAll);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [status, setStatus] = useState('');
  /** Cada guardado renueva el editor con lo que devolvió la API (archivada, avisos, km). */
  const [rev, setRev] = useState(0);

  const routes = data?.routes ?? [];
  const modalities = [...new Set(company.services.map((s) => s.modality))].filter(
    (m): m is Modality => m === 'RIVER' || m === 'LAND',
  );
  const current =
    selected === 'new'
      ? null
      : (routes.find((r) => r.id === selected) ?? (selected ? null : routes[0]) ?? null);
  const editing = selected === 'new' || current !== null;
  const active = routes.filter((r) => !r.archived).length;

  return (
    <>
      <PageHeader
        title="Rutas"
        subtitle={
          data
            ? `${active} ${active === 1 ? 'ruta activa' : 'rutas activas'}${
                routes.length > active
                  ? ` · ${routes.length - active} archivada${routes.length - active === 1 ? '' : 's'}`
                  : ''
              }`
            : 'Paradas en orden, tiempos y trazas de cada ruta.'
        }
        actions={
          <button
            type="button"
            className={PRIMARY}
            disabled={!data || modalities.length === 0}
            onClick={() => setSelected('new')}
          >
            Nueva ruta
          </button>
        }
      />
      <LiveStatus message={status} />
      <div className={PAGE_BODY}>
        {error && <Alert>{error}</Alert>}
        {!data ? (
          !error && <Loading what="las rutas" />
        ) : routes.length === 0 && selected !== 'new' ? (
          <Empty>
            Aún no hay rutas. Crea la primera con «Nueva ruta»: sus paradas son las ubicaciones de la empresa
            (puertos, terminales, embarcaderos), en el orden del recorrido.
          </Empty>
        ) : (
          <div className="flex flex-wrap items-start gap-5">
            <section
              aria-labelledby="h-routes"
              className="flex min-w-0 flex-[1_1_18rem] flex-col rounded-xl border border-divider bg-raised lg:max-w-[24rem]"
            >
              <h2 id="h-routes" className={`${CARD_TITLE} px-5 pt-4 pb-2`}>
                Rutas
              </h2>
              <ul>
                {routes.map((r) => {
                  const on = selected !== 'new' && r.id === current?.id;
                  const last = r.stops[r.stops.length - 1];
                  return (
                    <li key={r.id} className="border-t border-divider">
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => setSelected(r.id)}
                        className={`flex min-h-16 w-full flex-col gap-0.5 px-5 py-2.5 text-left ${
                          on ? 'bg-action/10 shadow-[inset_0_0_0_2px_var(--text-primary)]' : 'hover:bg-ink/5'
                        }`}
                      >
                        <span className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-bold">
                          {r.code} · {r.name}
                          {r.archived && <Chip tone="none">Archivada</Chip>}
                        </span>
                        <span className="text-[0.8125rem] text-ink-muted">
                          {[
                            MODALITY_NAME[r.modality],
                            `${r.stops.length} paradas`,
                            r.totalKm !== null && `${fmtNumber(r.totalKm)} km`,
                            last && formatDuration(last.offsetMinutes),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
            {editing && (
              <RouteEditor
                key={`${current?.id ?? 'new'}:${rev}`}
                route={current}
                modalities={modalities}
                locations={data.locations}
                kinds={data.kinds}
                onSaved={async (r, verb) => {
                  await reload();
                  setSelected(r.id);
                  setRev((n) => n + 1);
                  setStatus(`Ruta ${r.code} ${verb}`);
                }}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

function RouteEditor({
  route,
  modalities,
  locations,
  kinds,
  onSaved,
}: {
  route: Route | null;
  modalities: Modality[];
  locations: Location[];
  kinds: { code: string; name: string }[];
  onSaved: (r: Route, verb: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    route
      ? toDraft(route)
      : {
          id: null,
          code: '',
          name: '',
          modality: modalities[0] ?? 'RIVER',
          archived: false,
          stops: [{ ...emptyStop(), offset: '0 min', allowsAlighting: false }, emptyStop()],
        },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const table = useRef<HTMLTableSectionElement>(null);

  useEffect(() => {
    if (!focusKey) return;
    table.current?.querySelector<HTMLElement>(`[data-row="${focusKey}"] select`)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  const byId = new Map(locations.map((l) => [l.id, l]));
  const kindName = (code: string) => kinds.find((k) => k.code === code)?.name ?? code;
  const choices = locations.filter((l) => !l.archived);
  const readOnly = draft.archived;
  const n = draft.stops.length;

  const update = (i: number, patch: Partial<StopDraft>) =>
    setDraft((d) => ({ ...d, stops: d.stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const move = (i: number, to: number) => {
    if (to < 0 || to >= n) return;
    setDraft((d) => {
      const stops = [...d.stops];
      const [s] = stops.splice(i, 1);
      stops.splice(to, 0, s as StopDraft);
      return { ...d, stops };
    });
    const name = byId.get(draft.stops[i]?.locationId ?? '')?.name ?? 'La parada';
    setStatus(`${name} ahora es la parada ${to + 1} de ${n}`);
    setFocusKey(draft.stops[i]?.key ?? null);
  };
  const remove = (i: number) => setDraft((d) => ({ ...d, stops: d.stops.filter((_, j) => j !== i) }));
  const onRowKey = (i: number) => (e: KeyboardEvent) => {
    if (!e.altKey || readOnly) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      move(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
    }
  };

  /** Km del tramo i → i+1: por la traza, en línea recta o null si alguna parada no está en el mapa. */
  const legKm = (i: number): number | null => {
    const s = draft.stops[i];
    const next = draft.stops[i + 1];
    if (!s || !next) return null;
    if (s.pathToNext) return roundKm(pathLengthKm(s.pathToNext));
    const a = byId.get(s.locationId);
    const b = byId.get(next.locationId);
    if (a?.lat == null || a.lng == null || b?.lat == null || b.lng == null) return null;
    return roundKm(distanceKm([a.lng, a.lat], [b.lng, b.lat]));
  };
  let acc: number | null = 0;
  const fromOrigin = draft.stops.map((_, i) => {
    const here = acc;
    const leg = legKm(i);
    if (i < n - 1) acc = acc === null || leg === null ? null : roundKm(acc + leg);
    return here;
  });

  const onTrace = async (i: number, file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const t = await importTrace(file);
      update(i, { pathToNext: t.points as LngLat[] });
      setStatus(
        `Traza importada (${t.format}): ${t.points.length} puntos${
          t.sourcePoints > t.points.length ? ` de ${t.sourcePoints}` : ''
        }, ${fmtNumber(t.km)} km. Se guarda con la ruta.`,
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const save = async () => {
    setError(null);
    const bad: Record<string, string> = {};
    const stops = draft.stops.map((s, i) => {
      const offset = i === 0 ? 0 : parseDuration(s.offset);
      const dwell = i === 0 || i === n - 1 ? 0 : parseDuration(s.dwell);
      if (offset === null) bad[`${i}.offsetMinutes`] = 'Escribe un tiempo, p. ej. 12 h o 1 d 6 h';
      if (dwell === null) bad[`${i}.dwellMinutes`] = 'Escribe un tiempo, p. ej. 30 min';
      if (!s.locationId) bad[`${i}.locationId`] = 'Elige la parada';
      return {
        locationId: s.locationId,
        offsetMinutes: offset ?? 0,
        dwellMinutes: dwell ?? 0,
        allowsBoarding: i === 0 ? true : s.allowsBoarding,
        allowsAlighting: i === n - 1 ? true : s.allowsAlighting,
        pathToNext: i === n - 1 ? null : s.pathToNext,
      };
    });
    const body = { name: draft.name, stops };
    const parsed = draft.id
      ? UpdateRouteRequestSchema.safeParse(body)
      : CreateRouteRequestSchema.safeParse({ ...body, code: draft.code, modality: draft.modality });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key =
          issue.path[0] === 'stops'
            ? `${String(issue.path[1])}.${String(issue.path[2])}`
            : String(issue.path[0]);
        bad[key] ??= issue.message;
      }
    }
    setIssues(bad);
    if (Object.keys(bad).length > 0 || !parsed.success) {
      setError('Revisa los campos marcados.');
      return;
    }
    setBusy(true);
    try {
      const saved = draft.id
        ? await routesApi.update(draft.id, UpdateRouteRequestSchema.parse(body))
        : await routesApi.create(parsed.data as Parameters<typeof routesApi.create>[0]);
      await onSaved(saved, draft.id ? 'guardada' : 'creada');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async () => {
    if (!route) return;
    setBusy(true);
    setError(null);
    try {
      const r = await (route.archived ? routesApi.restore(route.id) : routesApi.archive(route.id));
      await onSaved(r, route.archived ? 'restaurada' : 'archivada');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const err = (k: string) => issues[k];

  return (
    <section aria-labelledby="h-route" className="flex min-w-0 flex-[999_1_40rem] flex-col gap-4">
      <LiveStatus message={status} />
      <div className={CARD}>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex flex-col gap-1">
            <h2 id="h-route" className="font-display text-xl font-extrabold">
              {route ? `${route.code} · ${route.name}` : 'Nueva ruta'}
            </h2>
            <p className="text-sm text-ink-muted">
              {route
                ? `${MODALITY_NAME[route.modality]} · el código y la modalidad no cambian${
                    route.totalKm !== null ? ` · ${fmtNumber(route.totalKm)} km en total` : ''
                  }`
                : 'El código y la modalidad no cambian después de crearla.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {route && (
              <button
                type="button"
                className={SECONDARY}
                disabled={busy}
                onClick={() => void toggleArchive()}
              >
                {route.archived ? 'Restaurar' : 'Archivar'}
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                className={PRIMARY}
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => void save()}
              >
                {busy ? 'Guardando…' : route ? 'Guardar cambios' : 'Crear ruta'}
              </button>
            )}
          </div>
        </div>

        {error && <Alert>{error}</Alert>}
        {readOnly && (
          <Warning>La ruta está archivada: restáurala para editarla o crear viajes con ella.</Warning>
        )}
        {route?.warnings.map((w) => (
          <Warning key={w}>
            <strong>{w}.</strong> Es un aviso: la ruta se guarda igual. Si atracan en un puerto de la ciudad,
            regístralo en Ubicaciones y úsalo como parada.
          </Warning>
        ))}

        <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,12rem)]">
          {!route && (
            <Input
              label="Código"
              value={draft.code}
              onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value.toUpperCase() }))}
              error={err('code')}
              hint="Ej.: PCL-IQT. No cambia después."
              maxLength={16}
              autoComplete="off"
            />
          )}
          <Input
            label="Nombre"
            value={draft.name}
            disabled={readOnly}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            error={err('name')}
            maxLength={80}
          />
          {!route && (
            <Select
              label="Modalidad"
              value={draft.modality}
              onChange={(e) => setDraft((d) => ({ ...d, modality: e.target.value as Modality }))}
            >
              {modalities.map((m) => (
                <option key={m} value={m}>
                  {MODALITY_NAME[m]}
                </option>
              ))}
            </Select>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <h3 className={CARD_TITLE}>Paradas en orden</h3>
          <p className="text-[0.8125rem] text-ink-muted">
            El tiempo se cuenta desde la salida del origen (escribe, p. ej., «12 h» o «1 d 6 h»). Para mover
            una parada, usa sus botones o Alt + flechas con el foco en su fila. Editar la ruta no cambia los
            viajes ya creados.
          </p>
        </div>

        <ScrollRegion label="Paradas de la ruta">
          <table className="w-full min-w-[60rem] border-collapse">
            <thead>
              <tr className="bg-canvas">
                <th scope="col" className={TH}>
                  #
                </th>
                <th scope="col" className={TH}>
                  Parada
                </th>
                <th scope="col" className={TH}>
                  Llega
                </th>
                <th scope="col" className={TH}>
                  Se detiene
                </th>
                <th scope="col" className={TH}>
                  Suben
                </th>
                <th scope="col" className={TH}>
                  Bajan
                </th>
                <th scope="col" className={TH}>
                  Tramo siguiente
                </th>
                <th scope="col" className={TH}>
                  <span className="sr-only">Orden</span>
                </th>
              </tr>
            </thead>
            <tbody ref={table}>
              {draft.stops.map((s, i) => {
                const loc = byId.get(s.locationId);
                const name = loc?.name ?? `Parada ${i + 1}`;
                const origin = i === 0;
                const dest = i === n - 1;
                const offsetMin = origin ? 0 : parseDuration(s.offset);
                const km = legKm(i);
                return (
                  <tr
                    key={s.key}
                    data-row={s.key}
                    className="border-t border-divider"
                    onKeyDown={onRowKey(i)}
                  >
                    <td className={`${TD} font-bold`}>{i + 1}</td>
                    <td className={TD}>
                      <label className="sr-only" htmlFor={`stop-${s.key}`}>
                        Parada {i + 1}
                      </label>
                      <select
                        id={`stop-${s.key}`}
                        value={s.locationId}
                        disabled={readOnly}
                        aria-invalid={err(`${i}.locationId`) ? true : undefined}
                        onChange={(e) => update(i, { locationId: e.target.value })}
                        className="min-h-11 w-52 rounded-[var(--radius-control)] border border-control bg-raised px-2.5 text-[0.9375rem]"
                      >
                        <option value="">Elige una ubicación</option>
                        {choices.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name} · {kindName(l.kind)}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-[0.8125rem] text-ink-muted">
                        {origin ? 'Origen' : dest ? 'Destino' : 'Intermedia'}
                        {loc && loc.lat === null ? ' · sin ubicar en el mapa' : ''}
                      </span>
                      {err(`${i}.locationId`) && (
                        <span className="block text-[0.8125rem] font-semibold text-danger">
                          {err(`${i}.locationId`)}
                        </span>
                      )}
                    </td>
                    <td className={TD}>
                      {origin ? (
                        <span className="text-ink-muted">Sale a la hora del viaje</span>
                      ) : (
                        <span className="flex flex-col gap-1">
                          <input
                            aria-label={`${name}: tiempo desde la salida`}
                            value={s.offset}
                            disabled={readOnly}
                            onChange={(e) => update(i, { offset: e.target.value })}
                            className={SMALL_INPUT}
                          />
                          <span className="text-[0.8125rem] text-ink-muted">
                            {offsetMin !== null && `día ${dayOf(offsetMin)} · +${formatDuration(offsetMin)}`}
                          </span>
                          {err(`${i}.offsetMinutes`) && (
                            <span className="text-[0.8125rem] font-semibold text-danger">
                              {err(`${i}.offsetMinutes`)}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className={TD}>
                      {origin || dest ? (
                        <span className="text-ink-muted">—</span>
                      ) : (
                        <span className="flex flex-col gap-1">
                          <input
                            aria-label={`${name}: tiempo detenido`}
                            value={s.dwell}
                            disabled={readOnly}
                            onChange={(e) => update(i, { dwell: e.target.value })}
                            className={SMALL_INPUT}
                          />
                          {err(`${i}.dwellMinutes`) && (
                            <span className="text-[0.8125rem] font-semibold text-danger">
                              {err(`${i}.dwellMinutes`)}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className={TD}>
                      <input
                        type="checkbox"
                        aria-label={`En ${name} suben pasajeros${origin ? ' (siempre en el origen)' : ''}`}
                        checked={origin ? true : s.allowsBoarding}
                        disabled={readOnly || origin}
                        onChange={(e) => update(i, { allowsBoarding: e.target.checked })}
                        className="size-5"
                      />
                    </td>
                    <td className={TD}>
                      <input
                        type="checkbox"
                        aria-label={`En ${name} bajan pasajeros${dest ? ' (siempre en el destino)' : ''}`}
                        checked={dest ? true : s.allowsAlighting}
                        disabled={readOnly || dest}
                        onChange={(e) => update(i, { allowsAlighting: e.target.checked })}
                        className="size-5"
                      />
                      {err(`${i}.allowsBoarding`) && (
                        <span className="block text-[0.8125rem] font-semibold text-danger">
                          {err(`${i}.allowsBoarding`)}
                        </span>
                      )}
                    </td>
                    <td className={TD}>
                      {dest ? (
                        <span className="text-ink-muted">Destino</span>
                      ) : (
                        <span className="flex flex-col items-start gap-1">
                          <span>
                            <strong>{km === null ? 'Sin km' : `${fmtNumber(km)} km`}</strong> ·{' '}
                            {s.pathToNext
                              ? 'con traza'
                              : km === null
                                ? 'ubica las paradas en el mapa'
                                : 'línea recta'}
                          </span>
                          {!readOnly && (
                            <span className="flex flex-wrap gap-1">
                              <label className={`${ROW_ACTION} cursor-pointer`}>
                                {s.pathToNext ? 'Cambiar traza' : 'Importar GPX o KML'}
                                <input
                                  type="file"
                                  accept=".gpx,.kml"
                                  className="sr-only"
                                  onChange={(e) => {
                                    void onTrace(i, e.target.files?.[0]);
                                    e.target.value = '';
                                  }}
                                />
                              </label>
                              {s.pathToNext && (
                                <button
                                  type="button"
                                  className={ROW_ACTION}
                                  onClick={() => update(i, { pathToNext: null })}
                                >
                                  Quitar traza
                                </button>
                              )}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>
                      {!readOnly && (
                        <span className="flex gap-1">
                          <button
                            type="button"
                            className={ROW_ACTION}
                            aria-label={`Subir ${name}`}
                            disabled={i === 0}
                            onClick={() => move(i, i - 1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className={ROW_ACTION}
                            aria-label={`Bajar ${name}`}
                            disabled={i === n - 1}
                            onClick={() => move(i, i + 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className={ROW_ACTION}
                            aria-label={`Quitar ${name}`}
                            disabled={n <= 2}
                            onClick={() => remove(i)}
                          >
                            Quitar
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <button
              type="button"
              className={SECONDARY}
              disabled={n >= ROUTE_MAX_STOPS}
              onClick={() => setDraft((d) => ({ ...d, stops: [...d.stops, emptyStop()] }))}
            >
              Agregar parada
            </button>
            <span className="text-[0.8125rem] text-ink-muted">
              De 2 a {ROUTE_MAX_STOPS} paradas. Una parada intermedia permite subir, bajar o ambas.
            </span>
          </div>
        )}
      </div>

      <div className={CARD}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className={CARD_TITLE}>Recorrido</h3>
          <span className="text-[0.8125rem] text-ink-muted">
            El mapa llega en la 7.6; mientras, el esquema de tramos.
          </span>
        </div>
        <ol aria-label="Tramos de la ruta" className="grid gap-3 sm:grid-flow-col sm:auto-cols-fr">
          {draft.stops.map((s, i) => {
            const offset = i === 0 ? 0 : parseDuration(s.offset);
            return (
              <li key={s.key} className="flex flex-col gap-1.5">
                <span className="flex items-center gap-2" aria-hidden="true">
                  <span className="size-3.5 shrink-0 rounded-full bg-ink" />
                  {i < n - 1 && (
                    <span
                      className={`h-0 flex-1 border-t-[3px] ${s.pathToNext ? 'border-action' : 'border-dashed border-control'}`}
                    />
                  )}
                </span>
                <span className="text-sm font-bold">{byId.get(s.locationId)?.name ?? `Parada ${i + 1}`}</span>
                <span className="text-[0.8125rem] text-ink-muted">
                  {fromOrigin[i] === null ? 'km sin calcular' : `${fmtNumber(fromOrigin[i] as number)} km`}
                  {offset !== null && i > 0 ? ` · +${formatDuration(offset)}` : i === 0 ? ' · sale' : ''}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-ink-muted">
          <span>
            <span
              aria-hidden="true"
              className="mr-1 inline-block w-6 border-t-[3px] border-action align-middle"
            />
            con traza
          </span>
          <span>
            <span
              aria-hidden="true"
              className="mr-1 inline-block w-6 border-t-[3px] border-dashed border-control align-middle"
            />
            línea recta (sin traza)
          </span>
        </p>
      </div>
    </section>
  );
}
