'use client';

import type { Fare, FareMatrix, FareService, Route } from '@yebo/contracts';
import { Dialog } from '@yebo/ui/dialog';
import { Alert, Input, PRIMARY, SECONDARY, ScrollRegion, Select } from '@yebo/ui/form';
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
  PageHeader,
  ROW_ACTION,
  fmtDate,
  today,
  useLoad,
  type ChipTone,
} from '@/components/panel/kit';
import { usePanel } from '@/components/panel/panel-session';
import { faresApi, routesApi } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';

const SERVICE_NAME: Record<FareService, string> = {
  PASSENGER: 'Pasajeros',
  VEHICLE_TRANSPORT: 'Transporte de vehículos',
};
const PHASE: Record<Fare['phase'], { label: string; tone: ChipTone }> = {
  CURRENT: { label: 'Vigente', tone: 'ok' },
  SCHEDULED: { label: 'Programada', tone: 'none' },
  ENDED: { label: 'Terminada', tone: 'none' },
  CANCELLED: { label: 'Anulada', tone: 'bad' },
};

/** «S/ 1 234,50». */
export const fmtSoles = (amount: string) =>
  `S/ ${Number(amount).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Monto como se escribe en Perú («45,50», «1 200») al formato de la API («45.50»). */
export const toAmount = (text: string) => text.replace(/\s/g, '').replace(',', '.');
/** «GENERAL» → «General»; las siglas cortas (VIP) quedan igual. */
export const className = (code: string) =>
  code.length <= 3 ? code : code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

type Cell = { origin: string; destination: string; cls: string };
const keyOf = (c: Cell) => `${c.origin}|${c.destination}|${c.cls}`;

const loadRoutes = async () => (await routesApi.list()).routes.filter((r) => !r.archived);

/**
 * Tarifas (Fase 7.5a; API de la 7.2, maqueta 7.5 aprobada): matriz tramo × clase de una ruta en una fecha, con lo
 * que falta. Una tarifa no se edita: el cambio de precio crea otra desde una fecha y la vigente termina ese día.
 */
export function FaresView() {
  const { company } = usePanel();
  const routes = useLoad(loadRoutes);
  const [routeId, setRouteId] = useState('');
  const [service, setService] = useState<FareService>('PASSENGER');
  const [date, setDate] = useState(() => today());
  const [raw, setRaw] = useState<FareMatrix | null>(null);
  /** Clases agregadas a mano (sin plano que las tenga todavía): columnas nuevas hasta que tengan precio. */
  const [extra, setExtra] = useState<string[]>([]);
  const [newClass, setNewClass] = useState('');
  const [history, setHistory] = useState<Fare[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cell, setCell] = useState<Cell | null>(null);
  const [bulk, setBulk] = useState(false);
  const [status, setStatus] = useState('');

  const route: Route | undefined = routes.data?.find((r) => r.id === routeId) ?? routes.data?.[0];
  const services = (['PASSENGER', 'VEHICLE_TRANSPORT'] as const).filter((s) =>
    company.services.some((x) => x.service === s && route && x.modality === route.modality),
  );
  const svc = services.includes(service) ? service : (services[0] ?? 'PASSENGER');

  const refresh = useCallback(async () => {
    if (!route) return;
    setLoadError(null);
    try {
      const [m, l] = await Promise.all([faresApi.matrix(route.id, svc, date), faresApi.list(route.id)]);
      setRaw(m);
      setHistory(l.fares.filter((f) => f.service === svc));
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [route, svc, date]);
  useEffect(() => {
    setRaw(null);
    setExtra([]);
    void refresh();
  }, [refresh]);

  // La matriz con las clases agregadas a mano: cada una suma sus tramos a lo que falta.
  const added = raw ? extra.filter((c) => !raw.classes.some((x) => x.code === c)) : [];
  const matrix: FareMatrix | null = raw && {
    ...raw,
    classes: [...raw.classes, ...added.map((code) => ({ code, inLayouts: false }))],
    missing: [
      ...raw.missing,
      ...added.flatMap((c) =>
        raw.pairs.map((p) => ({
          originLocationId: p.originLocationId,
          destinationLocationId: p.destinationLocationId,
          priceClassCode: c,
        })),
      ),
    ],
  };

  const priced = new Map(
    (matrix?.fares ?? []).map((f) => [
      keyOf({ origin: f.originLocationId, destination: f.destinationLocationId, cls: f.priceClassCode }),
      f,
    ]),
  );
  const nextChange = (c: Cell) =>
    history
      .filter(
        (f) =>
          f.status === 'ACTIVE' &&
          f.validFrom > date &&
          keyOf({
            origin: f.originLocationId,
            destination: f.destinationLocationId,
            cls: f.priceClassCode,
          }) === keyOf(c),
      )
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0];
  const offRoute = history.filter((f) => !f.onRoute && f.phase !== 'ENDED' && f.phase !== 'CANCELLED');
  const total = (matrix?.pairs.length ?? 0) * (matrix?.classes.length ?? 0);

  const after = async (message: string) => {
    await refresh();
    setStatus(message);
  };

  return (
    <>
      <PageHeader
        title="Tarifas"
        subtitle="Precio por tramo y clase, en soles. Una tarifa no se edita: un cambio de precio crea otra desde una fecha."
        actions={
          <button
            type="button"
            className={PRIMARY}
            disabled={!matrix || matrix.missing.length === 0}
            onClick={() => setBulk(true)}
          >
            Poner precios
          </button>
        }
      />
      <LiveStatus message={status} />
      <div className={PAGE_BODY}>
        {routes.error && <Alert>{routes.error}</Alert>}
        {!routes.data ? (
          !routes.error && <Loading what="las rutas" />
        ) : routes.data.length === 0 ? (
          <Empty>
            Para poner precios, primero crea una ruta en{' '}
            <Link href="/panel/rutas" className="font-semibold underline underline-offset-4">
              Rutas
            </Link>
            .
          </Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
              <div className="min-w-64">
                <Select
                  label="Ruta"
                  value={route?.id ?? ''}
                  onChange={(e) => {
                    setRouteId(e.target.value);
                    setCell(null);
                  }}
                >
                  {routes.data.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.code} · {r.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="min-w-52">
                <Select
                  label="Servicio"
                  value={svc}
                  onChange={(e) => {
                    setService(e.target.value as FareService);
                    setCell(null);
                  }}
                >
                  {services.map((s) => (
                    <option key={s} value={s}>
                      {SERVICE_NAME[s]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="min-w-44">
                <Input
                  label="Precios vigentes el"
                  type="date"
                  value={date}
                  onChange={(e) => e.target.value && setDate(e.target.value)}
                />
              </div>
              {matrix && (
                <p className="pb-3 text-sm">
                  <strong>{matrix.missing.length} sin precio</strong>{' '}
                  <span className="text-ink-muted">de {total} tramos y clases</span>
                </p>
              )}
            </div>
            {loadError && <Alert>{loadError}</Alert>}
            {services.length === 0 ? (
              <Empty>
                La empresa no opera pasajeros ni transporte de vehículos en la modalidad de esta ruta.
              </Empty>
            ) : !matrix ? (
              !loadError && <Loading what="la matriz" />
            ) : (
              <div className="flex flex-wrap items-start gap-5">
                <section aria-labelledby="h-matrix" className={`${CARD} min-w-0 flex-[999_1_38rem]`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 id="h-matrix" className={CARD_TITLE}>
                      Matriz de precios
                    </h2>
                    <span className="text-[0.8125rem] text-ink-muted">
                      Clases de los planos asignados a la flota, más las que ya tienen precio
                    </span>
                  </div>
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const code = newClass.trim().toUpperCase().replace(/\s+/g, '_');
                      if (!code) return;
                      setExtra((x) => (x.includes(code) ? x : [...x, code]));
                      setNewClass('');
                      setStatus(`Clase ${className(code)} agregada: pon sus precios`);
                    }}
                  >
                    <div className="w-52">
                      <Input
                        label="Nueva clase de precio"
                        value={newClass}
                        onChange={(e) => setNewClass(e.target.value)}
                        pattern="\s*[A-Za-z][A-Za-z0-9_ ]{1,23}\s*"
                        placeholder="p. ej. VIP"
                        autoComplete="off"
                      />
                    </div>
                    <button type="submit" className={SECONDARY}>
                      Agregar clase
                    </button>
                  </form>
                  {matrix.classes.length === 0 ? (
                    <Empty>
                      Aún no hay clases de precio: asigna un plano publicado a una unidad de esta modalidad, o
                      agrega una clase (p. ej., GENERAL) para poner sus precios.
                    </Empty>
                  ) : (
                    <ScrollRegion label="Tabla de precios">
                      <table className="w-full min-w-[40rem] border-collapse text-sm">
                        <caption className="sr-only">
                          Precios de {SERVICE_NAME[svc].toLowerCase()} de la ruta {route?.name} vigentes el{' '}
                          {fmtDate(date)}
                        </caption>
                        <thead>
                          <tr className="bg-canvas text-left">
                            <th scope="col" className="px-3 py-2.5 font-semibold">
                              Tramo
                            </th>
                            {matrix.classes.map((c) => (
                              <th key={c.code} scope="col" className="px-3 py-2.5 font-semibold">
                                {className(c.code)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {matrix.pairs.map((p) => (
                            <tr
                              key={`${p.originLocationId}|${p.destinationLocationId}`}
                              className="border-t border-divider"
                            >
                              <th scope="row" className="px-3 py-2 text-left font-semibold">
                                {p.originName} → {p.destinationName}
                              </th>
                              {matrix.classes.map((c) => {
                                const k: Cell = {
                                  origin: p.originLocationId,
                                  destination: p.destinationLocationId,
                                  cls: c.code,
                                };
                                const f = priced.get(keyOf(k));
                                const next = nextChange(k);
                                const on = cell !== null && keyOf(cell) === keyOf(k);
                                const where = `${p.originName} a ${p.destinationName}, ${className(c.code)}`;
                                return (
                                  <td key={c.code} className="px-2 py-1.5">
                                    <button
                                      type="button"
                                      aria-pressed={on}
                                      aria-label={f ? undefined : `${where}: sin precio. Poner precio`}
                                      onClick={() => setCell(k)}
                                      className={`flex min-h-11 w-full flex-col justify-center rounded-[var(--radius-control)] px-2.5 text-left ${
                                        on
                                          ? 'border-2 border-ink bg-action/10'
                                          : f
                                            ? 'border border-divider bg-raised hover:bg-action/10'
                                            : 'border border-dashed border-control bg-canvas text-ink-muted hover:bg-action/10'
                                      }`}
                                    >
                                      <span className="font-semibold">
                                        {f ? fmtSoles(f.amount) : 'Sin precio'}
                                      </span>
                                      {next && (
                                        <span className="text-xs font-semibold text-ink-muted">
                                          {f && Number(next.amount) < Number(f.amount) ? 'baja' : 'cambia'} a{' '}
                                          {fmtSoles(next.amount)} el {fmtDate(next.validFrom)}
                                        </span>
                                      )}
                                    </button>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </ScrollRegion>
                  )}
                  <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
                    Solo aparecen los tramos en que se puede viajar: se sube en el origen y se baja después en
                    el destino. Un tramo que deja de existir al editar la ruta conserva sus precios, pero no
                    se vende.
                  </p>
                  {offRoute.length > 0 && (
                    <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
                      Fuera de la ruta:{' '}
                      {offRoute
                        .map((f) => `${f.originName} → ${f.destinationName} (${className(f.priceClassCode)})`)
                        .join(', ')}
                      .
                    </p>
                  )}
                </section>

                {cell && route && matrix && (
                  <CellPanel
                    key={keyOf(cell)}
                    cell={cell}
                    routeId={route.id}
                    service={svc}
                    date={date}
                    matrix={matrix}
                    history={history.filter(
                      (f) =>
                        keyOf({
                          origin: f.originLocationId,
                          destination: f.destinationLocationId,
                          cls: f.priceClassCode,
                        }) === keyOf(cell),
                    )}
                    onDone={after}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
      {bulk && route && matrix && (
        <BulkDialog
          routeId={route.id}
          service={svc}
          date={date}
          matrix={matrix}
          onClose={() => setBulk(false)}
          onSaved={async (n) => {
            setBulk(false);
            await after(`${n} ${n === 1 ? 'precio guardado' : 'precios guardados'}`);
          }}
        />
      )}
    </>
  );
}

function CellPanel({
  cell,
  routeId,
  service,
  date,
  matrix,
  history,
  onDone,
}: {
  cell: Cell;
  routeId: string;
  service: FareService;
  date: string;
  matrix: FareMatrix;
  history: Fare[];
  onDone: (message: string) => Promise<void>;
}) {
  const pair = matrix.pairs.find(
    (p) => p.originLocationId === cell.origin && p.destinationLocationId === cell.destination,
  );
  const title = `${pair?.originName} → ${pair?.destinationName} · ${className(cell.cls)}`;
  const start = date > today() ? date : today();
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(start);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState<Fare | null>(null);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      await onDone(await fn());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await faresApi.create(routeId, {
        service,
        validFrom: from,
        validTo: to || null,
        items: [
          {
            originLocationId: cell.origin,
            destinationLocationId: cell.destination,
            priceClassCode: cell.cls,
            amount: toAmount(amount),
          },
        ],
      });
      setAmount('');
      const ended = r.ended[0];
      return `Precio ${fmtSoles(r.fares[0]?.amount ?? '0')} desde el ${fmtDate(from)}${
        ended ? `; el de ${fmtSoles(ended.amount)} termina ese día` : ''
      }`;
    });
  };
  const sorted = [...history].sort((a, b) => b.validFrom.localeCompare(a.validFrom));

  return (
    <section
      aria-labelledby="h-cell"
      className="flex min-w-0 flex-[1_1_20rem] flex-col gap-4 lg:max-w-[26rem]"
    >
      <div className={CARD}>
        <div className="flex flex-col gap-1">
          <h2 id="h-cell" className={CARD_TITLE}>
            {title}
          </h2>
          <p className="text-sm text-ink-muted">{SERVICE_NAME[service]}</p>
        </div>
        {error && <Alert>{error}</Alert>}
        {sorted.length === 0 ? (
          <Empty>Sin precios todavía para este tramo y clase.</Empty>
        ) : (
          <ol className="flex flex-col">
            {sorted.map((f) => (
              <li
                key={f.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-divider py-2.5"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-[0.9375rem] font-bold">{fmtSoles(f.amount)}</span>
                  <span className="text-[0.8125rem] text-ink-muted">
                    {f.validTo
                      ? `Del ${fmtDate(f.validFrom)} al ${fmtDate(f.validTo)} (el último día ya no vale)`
                      : `Desde el ${fmtDate(f.validFrom)}, sin fin`}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Chip tone={PHASE[f.phase].tone}>{PHASE[f.phase].label}</Chip>
                  {f.phase === 'SCHEDULED' && (
                    <button
                      type="button"
                      className={ROW_ACTION}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await faresApi.cancel(f.id);
                          return `Tarifa de ${fmtSoles(f.amount)} anulada`;
                        })
                      }
                    >
                      Anular
                    </button>
                  )}
                  {(f.phase === 'CURRENT' || f.phase === 'SCHEDULED') && (
                    <button type="button" className={ROW_ACTION} disabled={busy} onClick={() => setEnding(f)}>
                      Cambiar el fin
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <form aria-labelledby="h-change" onSubmit={create} className={CARD}>
        <h3 id="h-change" className={CARD_TITLE}>
          {sorted.some((f) => f.phase === 'CURRENT') ? 'Cambiar el precio' : 'Poner precio'}
        </h3>
        <Input
          label="Precio (S/)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          required
          pattern="\s*\d{1,5}([.,]\d{1,2})?\s*"
          hint="Hasta 2 decimales, p. ej. 45.50 (también 45,50)."
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Desde"
            type="date"
            value={from}
            min={today()}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
          <Input
            label="Hasta (opcional)"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
          El precio vigente termina el día en que empieza el nuevo. El pasado no cambia: el nuevo precio
          empieza hoy o más adelante. «Hasta» es el primer día en que ya no vale.
        </p>
        <button
          type="submit"
          className={`${PRIMARY} self-start`}
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {busy ? 'Guardando…' : 'Guardar el precio'}
        </button>
      </form>

      {ending && (
        <EndDialog
          fare={ending}
          onClose={() => setEnding(null)}
          onSaved={async (validTo) => {
            setEnding(null);
            await onDone(`La tarifa de ${fmtSoles(ending.amount)} ahora termina el ${fmtDate(validTo)}`);
          }}
        />
      )}
    </section>
  );
}

function EndDialog({
  fare,
  onClose,
  onSaved,
}: {
  fare: Fare;
  onClose: () => void;
  onSaved: (validTo: string) => Promise<void>;
}) {
  const [validTo, setValidTo] = useState(fare.validTo ?? today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await faresApi.end(fare.id, validTo);
      await onSaved(validTo);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Cambiar el fin de ${fmtSoles(fare.amount)}`}
      description={`${fare.originName} → ${fare.destinationName} · ${className(fare.priceClassCode)}. El día que elijas ya no vale.`}
      onRequestClose={onClose}
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        {error && <Alert>{error}</Alert>}
        <Input
          label="Termina el"
          type="date"
          value={validTo}
          min={today()}
          onChange={(e) => setValidTo(e.target.value)}
          required
        />
        <DialogActions busy={busy} label="Guardar el fin" onCancel={onClose} />
      </form>
    </Dialog>
  );
}

function BulkDialog({
  routeId,
  service,
  date,
  matrix,
  onClose,
  onSaved,
}: {
  routeId: string;
  service: FareService;
  date: string;
  matrix: FareMatrix;
  onClose: () => void;
  onSaved: (n: number) => Promise<void>;
}) {
  const names = new Map(
    matrix.pairs.flatMap((p) => [
      [p.originLocationId, p.originName],
      [p.destinationLocationId, p.destinationName],
    ]),
  );
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [from, setFrom] = useState(date > today() ? date : today());
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filled = matrix.missing.filter((m) =>
    (
      amounts[
        keyOf({ origin: m.originLocationId, destination: m.destinationLocationId, cls: m.priceClassCode })
      ] ?? ''
    ).trim(),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (filled.length === 0) {
      setError('Escribe al menos un precio.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await faresApi.create(routeId, {
        service,
        validFrom: from,
        validTo: to || null,
        items: filled.map((m) => ({
          originLocationId: m.originLocationId,
          destinationLocationId: m.destinationLocationId,
          priceClassCode: m.priceClassCode,
          amount: toAmount(
            amounts[
              keyOf({
                origin: m.originLocationId,
                destination: m.destinationLocationId,
                cls: m.priceClassCode,
              })
            ] ?? '',
          ),
        })),
      });
      await onSaved(filled.length);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Poner precios"
      description="Los tramos y clases sin precio. Deja en blanco los que no quieras poner ahora: se guardan todos o ninguno."
      onRequestClose={onClose}
      wide
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Desde"
            type="date"
            value={from}
            min={today()}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
          <Input
            label="Hasta (opcional)"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <ul className="flex max-h-[24rem] flex-col overflow-y-auto">
          {matrix.missing.map((m) => {
            const k = keyOf({
              origin: m.originLocationId,
              destination: m.destinationLocationId,
              cls: m.priceClassCode,
            });
            const label = `${names.get(m.originLocationId)} → ${names.get(m.destinationLocationId)} · ${className(m.priceClassCode)}`;
            return (
              <li key={k} className="flex items-center justify-between gap-3 border-t border-divider py-2">
                <label htmlFor={`bulk-${k}`} className="text-sm">
                  {label}
                </label>
                <span className="flex items-center gap-1.5 text-sm">
                  S/
                  <input
                    id={`bulk-${k}`}
                    inputMode="decimal"
                    value={amounts[k] ?? ''}
                    onChange={(e) => setAmounts((a) => ({ ...a, [k]: e.target.value }))}
                    className="min-h-11 w-28 rounded-[var(--radius-control)] border border-control bg-raised px-2.5 text-[0.9375rem]"
                  />
                </span>
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-ink-muted">
          {filled.length} de {matrix.missing.length} con precio
        </p>
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className={PRIMARY} disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Guardando…' : 'Guardar precios'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
