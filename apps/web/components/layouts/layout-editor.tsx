'use client';

import {
  CAPACITY_DIMENSIONS,
  LAYOUT_LIMITS,
  LayoutDocumentSchema,
  ZONE_RULES,
  deriveInventory,
  validateLayout,
  type CapacityDimension,
  type Layout,
  type LayoutDocument,
  type LayoutElement,
  type LayoutVersionDetail,
  type LayoutZone,
} from '@yebo/contracts';
import { Dialog } from '@yebo/ui/dialog';
import { Alert, INPUT, LINK, PRIMARY, SECONDARY } from '@yebo/ui/form';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CARD, CARD_TITLE, fmtNumber } from '@/components/panel/kit';
import {
  NEW_ZONE_KINDS,
  addBed,
  addCabin,
  addDeck,
  addSeat,
  addSeatRows,
  addZone,
  grid,
  issueTarget,
  meters,
  moveElement,
  nearest,
  passengerZones,
  removeDeck,
  removeElement,
  reshapeZone,
  setZoneCapacity,
  updateElement,
  updateZone,
  type NewZoneKind,
  type Result,
  type Selection,
} from '@/lib/layout-editor';
import { layoutsApi } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';
import { ZONE_NAME } from './layout-detail';

/**
 * Editor del plano (Fase 6.4c, maqueta aprobada v5). En escritorio ocupa la altura de la ventana: solo se desplazan
 * las columnas laterales y el plano queda a la vista. Teclado del plano: un solo punto de Tab; flechas para ir de un
 * elemento a otro; Enter toma el elemento, flechas lo mueven, Enter lo deja y Esc lo devuelve; Supr lo quita;
 * Ctrl+Z deshace. Cada cambio se guarda solo en el borrador; publicar crea una versión que ya no cambia.
 */

const ZOOMS = [
  { id: 'S', label: 'Pequeña', pxPerM: 28 },
  { id: 'M', label: 'Mediana', pxPerM: 44 },
  { id: 'L', label: 'Grande', pxPerM: 64 },
] as const;

const DIM_LABEL: Record<CapacityDimension, string> = {
  PERSONS: 'Personas',
  UNITS: 'Bultos',
  WEIGHT_KG: 'Peso (kg)',
  VOLUME_M3: 'Volumen (m³)',
  LINEAR_M: 'Metros lineales',
};
const SERVICE_NAME = {
  PASSENGER: 'Pasajeros',
  PARCEL: 'Encomiendas',
  CARGO: 'Carga',
  VEHICLE_TRANSPORT: 'Vehículos',
};

function capText(z: LayoutZone): string {
  return z.capacity
    .map((c) =>
      c.dimension === 'WEIGHT_KG'
        ? c.value >= 1000
          ? `${fmtNumber(c.value / 1000)} t`
          : `${fmtNumber(c.value)} kg`
        : `${fmtNumber(c.value)} ${{ PERSONS: 'personas', UNITS: 'bultos', VOLUME_M3: 'm³', LINEAR_M: 'm lineales' }[c.dimension]}`,
    )
    .join(' · ');
}

const zoneTone = (z: LayoutZone) =>
  ZONE_RULES[z.kind].mode === 'ASSIGNED'
    ? 'border-action bg-action/10'
    : z.kind === 'FREE_ZONE' || z.kind === 'HAMMOCK'
      ? 'border-ink-muted bg-ink/5'
      : 'border-warning bg-warning-surface';

const ELEMENT_NAME: Record<LayoutElement['kind'], string> = {
  SEAT: 'Asiento',
  BED: 'Cama',
  CABIN: 'Camarote',
  VEHICLE_SLOT: 'Espacio de vehículo',
  AISLE: 'Pasillo',
  STAIRS: 'Escalera',
  DOOR: 'Puerta',
  WC: 'Baño',
  LABEL: 'Rótulo',
  OTHER: 'Elemento',
};

function elementTitle(e: LayoutElement) {
  if (e.kind === 'BED')
    return e.parentCode ? `Cama ${e.code.split('-').pop()} de ${e.parentCode}` : `Cama suelta ${e.code}`;
  if (e.kind === 'LABEL' || e.kind === 'OTHER') return e.label ?? e.code;
  return `${ELEMENT_NAME[e.kind]} ${e.code}`;
}

type SaveState =
  { kind: 'saved' } | { kind: 'pending' } | { kind: 'saving' } | { kind: 'error'; message: string };

export function LayoutEditor({
  layout,
  detail,
  onPublished,
}: {
  layout: Layout;
  detail: LayoutVersionDetail;
  onPublished: () => Promise<void>;
}) {
  const [doc, setDoc] = useState<LayoutDocument>(detail.document);
  const [history, setHistory] = useState<LayoutDocument[]>([]);
  const [deck, setDeck] = useState(0);
  const [sel, setSel] = useState<Selection>({ type: 'none' });
  const [grab, setGrab] = useState<{ code: string; from: LayoutDocument } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]['id']>('M');
  const [save, setSave] = useState<SaveState>({ kind: 'saved' });
  const [confirming, setConfirming] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [focusCode, setFocusCode] = useState<string | null>(null);
  const plane = useRef<HTMLDivElement>(null);
  const issuesBox = useRef<HTMLDivElement>(null);

  // --- Guardado automático del borrador (con espera de 0,8 s y sin carreras) -------------------------------------
  const latest = useRef(doc);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const first = useRef(true);
  const saveNow = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const parsed = LayoutDocumentSchema.safeParse(latest.current);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setSave({
        kind: 'error',
        message: `No se guarda: ${issue?.message ?? 'hay un dato no válido'} (${issue?.path.join('.')})`,
      });
      return false;
    }
    const n = ++seq.current;
    setSave({ kind: 'saving' });
    try {
      await layoutsApi.saveDraft(layout.id, parsed.data);
      if (n === seq.current) setSave({ kind: 'saved' });
      return true;
    } catch (e) {
      if (n === seq.current) setSave({ kind: 'error', message: `No se pudo guardar: ${errorMessage(e)}` });
      return false;
    }
  }, [layout.id]);
  useEffect(() => {
    latest.current = doc;
    if (first.current) {
      first.current = false;
      return;
    }
    if (grab) return; // mientras se mueve un elemento tomado, se guarda al dejarlo
    setSave({ kind: 'pending' });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveNow(), 800);
  }, [doc, grab, saveNow]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (save.kind === 'pending' || save.kind === 'saving') e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [save.kind]);

  // --- Cambios con deshacer ---------------------------------------------------------------------------------------
  const commit = useCallback(
    (next: LayoutDocument, message: string, select?: Selection, withToast = false) => {
      setHistory((h) => [...h, doc].slice(-50));
      setDoc(next);
      setAnnounce(message);
      setToast(withToast ? message : null);
      if (select) setSel(select);
    },
    [doc],
  );
  const apply = (r: Result, withToast = false) => {
    if (r.doc === doc) {
      setAnnounce(r.message);
      return;
    }
    commit(r.doc, r.message, r.select, withToast);
    if (r.select?.type === 'element') setFocusCode(null);
  };
  const undo = useCallback(() => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setDoc(prev);
    setHistory(history.slice(0, -1));
    setGrab(null);
    setToast(null);
    setAnnounce('Cambio deshecho');
  }, [history]);

  useEffect(() => {
    if (!focusCode) return;
    plane.current?.querySelector<HTMLElement>(`[data-code="${CSS.escape(focusCode)}"]`)?.focus();
    setFocusCode(null);
  }, [focusCode, deck]);

  // --- Derivados ----------------------------------------------------------------------------------------------------
  const issues = useMemo(() => validateLayout(doc), [doc]);
  const inventory = useMemo(() => deriveInventory(doc), [doc]);
  const d = doc.decks[deck] ?? doc.decks[0]!;
  const g = grid(doc, deck);
  const C = (ZOOMS.find((z) => z.id === zoom)!.pxPerM * doc.cellCm) / 100;
  const deckZones = doc.zones.filter((z) => z.deck === deck);
  const deckEls = doc.elements
    .filter((e) => e.deck === deck)
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.parentCode ? 1 : 0) - (b.parentCode ? 1 : 0));
  const current = sel.type === 'element' ? (doc.elements.find((e) => e.code === sel.code) ?? null) : null;
  const selZone = sel.type === 'zone' ? (doc.zones.find((z) => z.code === sel.code) ?? null) : null;
  const tabStop = current && current.deck === deck ? current.code : deckEls[0]?.code;
  const targets = passengerZones(doc, deck);
  const [targetCode, setTargetCode] = useState<string | null>(null);
  const target = targets.find((z) => z.code === targetCode) ?? targets[0] ?? null;
  const published = layout.versions
    .filter((v) => v.status === 'PUBLISHED')
    .sort((a, b) => b.version - a.version)[0];

  // --- Formularios de «Añadir» ---------------------------------------------------------------------------------------
  const [seatL, setSeatL] = useState(2);
  const [seatR, setSeatR] = useState(2);
  const [rows, setRows] = useState(2);
  const [beds, setBeds] = useState(2);
  const [zoneKind, setZoneKind] = useState<NewZoneKind>('FREE_ZONE');
  const [zoneLen, setZoneLen] = useState('3');

  const noTarget = `${d.name} no tiene una zona de pasajeros: créala con «Crear zona».`;
  const withTarget = (f: (z: LayoutZone) => Result) => () => {
    if (!target) {
      setAnnounce(noTarget);
      return;
    }
    apply(f(target));
  };

  // --- Teclado del plano --------------------------------------------------------------------------------------------
  const onPlaneKey = (ev: KeyboardEvent) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      undo();
      return;
    }
    if (!current) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      if (grab) {
        setGrab(null);
        setAnnounce(`${current.code} colocado en la columna ${current.x + 1}, fila ${current.y + 1}`);
      } else {
        setHistory((h) => [...h, doc].slice(-50));
        setGrab({ code: current.code, from: doc });
        setAnnounce(
          `${current.code} tomado: muévelo con las flechas, Enter para dejarlo, Esc para devolverlo`,
        );
      }
      return;
    }
    if (ev.key === 'Escape' && grab) {
      ev.preventDefault();
      setDoc(grab.from);
      setHistory((h) => h.slice(0, -1));
      setGrab(null);
      setAnnounce(`${current.code} devuelto a su sitio`);
      setFocusCode(current.code);
      return;
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && !grab) {
      ev.preventDefault();
      apply(removeElement(doc, current.code), true);
      return;
    }
    const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as const;
    const dir = dirs[ev.key as keyof typeof dirs];
    if (!dir) return;
    ev.preventDefault();
    if (grab) {
      const r = moveElement(doc, current.code, dir[0], dir[1]);
      setDoc(r.doc);
      setAnnounce(r.message);
      setFocusCode(current.code);
    } else {
      const next = nearest(deckEls, current, ev.key as keyof typeof dirs);
      if (next) {
        setSel({ type: 'element', code: next.code });
        setFocusCode(next.code);
      }
    }
  };

  const goIssue = (path: string) => {
    const t = issueTarget(doc, path);
    if (!t) return;
    setDeck(t.deck);
    setSel(t.select);
    if (t.select.type === 'element') setFocusCode(t.select.code);
  };

  const publish = async () => {
    setPublishing(true);
    setPublishError(null);
    const ok = await saveNow();
    if (!ok) {
      setPublishing(false);
      setPublishError('Primero hay que guardar el borrador: revisa el aviso de guardado.');
      return;
    }
    try {
      await layoutsApi.publish(layout.id);
      await onPublished();
    } catch (e) {
      setPublishError(errorMessage(e));
      setPublishing(false);
    }
  };

  const saveText =
    save.kind === 'saved'
      ? 'Guardado en el borrador'
      : save.kind === 'pending'
        ? 'Cambios sin guardar…'
        : save.kind === 'saving'
          ? 'Guardando…'
          : save.message;

  const setDeckField = (patch: Partial<LayoutDocument['decks'][number]>, message: string) =>
    commit({ ...doc, decks: doc.decks.map((x, i) => (i === deck ? { ...x, ...patch } : x)) }, message);

  // ------------------------------------------------------------------------------------------------------------------
  return (
    <div className="flex min-w-0 flex-1 flex-col min-[1100px]:h-dvh min-[1100px]:overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-divider bg-raised px-4 py-3.5 sm:px-8 lg:px-10">
        <div className="flex min-w-0 flex-col gap-0.5">
          <nav aria-label="Ruta" className="text-sm text-ink-muted">
            <Link href="/panel/planos" className={LINK}>
              Planos
            </Link>{' '}
            <span aria-hidden="true">/</span> {layout.name}
          </nav>
          <h1 className="font-display text-2xl font-extrabold tracking-[-0.02em]">
            {layout.name} · borrador de la versión {detail.version}
          </h1>
          <p
            role="status"
            className={`text-sm ${save.kind === 'error' ? 'font-semibold text-danger' : 'text-ink-muted'}`}
          >
            {saveText} · celdas de {doc.cellCm} cm
            {published && ` · la versión ${published.version} sigue publicada`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" className={SECONDARY} onClick={undo} disabled={history.length === 0}>
            Deshacer
          </button>
          {issues.length === 0 ? (
            <button type="button" className={PRIMARY} onClick={() => setConfirming(true)}>
              Publicar versión {detail.version}…
            </button>
          ) : (
            <button
              type="button"
              className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-danger px-4 font-semibold text-danger hover:bg-danger-surface"
              onClick={() => issuesBox.current?.focus()}
            >
              Corregir {issues.length} {issues.length === 1 ? 'dato' : 'datos'} para publicar
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-start gap-5 px-4 py-4 sm:px-8 lg:px-10 min-[1100px]:min-h-0 min-[1100px]:flex-1 min-[1100px]:flex-nowrap min-[1100px]:items-stretch">
        {/* Columna izquierda: piso, zonas, capacidad y «Añadir». */}
        <section
          aria-label="Pisos, zonas y capacidad"
          className="flex w-full flex-col gap-4 min-[1100px]:h-full min-[1100px]:w-[18rem] min-[1100px]:shrink-0 min-[1100px]:overflow-y-auto min-[1100px]:overscroll-contain min-[1100px]:pr-1.5 min-[1100px]:pb-4"
        >
          <div className={CARD}>
            <h2 className={CARD_TITLE}>{d.name}</h2>
            <TextInput
              label="Nombre del piso"
              value={d.name}
              maxLength={40}
              onCommit={(v) => v.trim() && setDeckField({ name: v.trim() }, `Piso renombrado: ${v.trim()}`)}
            />
            <div className="grid grid-cols-2 gap-2.5">
              <MetersInput
                label="Largo (m)"
                value={d.lengthM}
                max={LAYOUT_LIMITS.maxLengthM}
                onCommit={(v) => setDeckField({ lengthM: v }, `${d.name}: ${fmtNumber(v)} m de largo`)}
              />
              <MetersInput
                label="Ancho (m)"
                value={d.widthM}
                max={LAYOUT_LIMITS.maxWidthM}
                onCommit={(v) => setDeckField({ widthM: v }, `${d.name}: ${fmtNumber(v)} m de ancho`)}
              />
            </div>
            <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
              {fmtNumber(d.lengthM)} × {fmtNumber(d.widthM)} m con celdas de {doc.cellCm} cm: grilla de{' '}
              {g.cols} columnas por {g.rows} filas. Múltiplos de 25 cm.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={SECONDARY}
                disabled={doc.decks.length >= LAYOUT_LIMITS.decks}
                onClick={() => {
                  const r = addDeck(doc);
                  apply(r);
                  setDeck(r.doc.decks.length - 1);
                }}
              >
                Añadir piso
              </button>
              <button
                type="button"
                className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-danger underline underline-offset-4 disabled:opacity-60"
                disabled={doc.decks.length === 1}
                onClick={() => {
                  const r = removeDeck(doc, deck);
                  apply(r, r.doc !== doc);
                  if (r.doc !== doc) setDeck(Math.max(0, deck - 1));
                }}
              >
                Quitar este piso
              </button>
            </div>
            <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
              Hasta {LAYOUT_LIMITS.decks} pisos, bodega incluida. Solo se quita un piso vacío.
            </p>
          </div>

          <div className={CARD}>
            <h2 className={CARD_TITLE}>Zonas de {d.name}</h2>
            {deckZones.length === 0 ? (
              <p className="text-sm">Este piso aún no tiene zonas: créalas con «Crear zona».</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {deckZones.map((z) => {
                  const on = selZone?.code === z.code;
                  return (
                    <li key={z.code}>
                      <button
                        type="button"
                        aria-pressed={on}
                        aria-describedby="zonas-ayuda"
                        onClick={() => setSel({ type: 'zone', code: z.code })}
                        onKeyDown={(ev) => {
                          const k = {
                            ArrowUp: [0, -1],
                            ArrowDown: [0, 1],
                            ArrowLeft: [-1, 0],
                            ArrowRight: [1, 0],
                          }[ev.key];
                          if (!k) return;
                          ev.preventDefault();
                          setSel({ type: 'zone', code: z.code });
                          apply(
                            reshapeZone(doc, z.code, (r) =>
                              ev.shiftKey
                                ? { ...r, w: r.w + k[0]!, h: r.h + k[1]! }
                                : { ...r, x: r.x + k[0]!, y: r.y + k[1]! },
                            ),
                          );
                        }}
                        className={`flex min-h-12 w-full flex-col items-start justify-center gap-0.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-left text-sm font-semibold ${
                          on ? 'border-2 border-ink bg-ink/5' : 'border border-divider hover:bg-ink/5'
                        }`}
                      >
                        <span>{z.name}</span>
                        <span className="text-[0.8125rem] font-medium text-ink-muted">
                          {meters(z.rect.w, doc.cellCm)} × {meters(z.rect.h, doc.cellCm)}
                          {z.capacity.length > 0 && ` · ${capText(z)}`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <p id="zonas-ayuda" className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
              Desde la lista: flechas para mover la zona y Mayús + flechas para cambiar su tamaño. Nunca sale
              del piso.
            </p>
          </div>

          <div className={CARD}>
            <h2 className={CARD_TITLE}>Lo que se venderá</h2>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-ink-muted">Asientos</dt>
              <dd className="text-right font-semibold">{inventory.summary.seats}</dd>
              <dt className="text-ink-muted">Camarotes ({inventory.summary.beds} camas en total)</dt>
              <dd className="text-right font-semibold">{inventory.summary.cabins}</dd>
              <dt className="text-ink-muted">Personas en zonas libres</dt>
              <dd className="text-right font-semibold">{inventory.summary.pooledPersons}</dd>
            </dl>
            <NumberInput
              label="Aforo total"
              value={doc.totalPersons}
              min={1}
              max={5000}
              hint={`Tope de personas a bordo (autoridad o tarjeta). Hoy asientos, camas y zonas libres suman ${
                inventory.summary.assignedPersons + inventory.summary.pooledPersons
              }.`}
              onCommit={(v) =>
                commit({ ...doc, totalPersons: v }, v === null ? 'Aforo total quitado' : `Aforo total: ${v}`)
              }
            />
            {doc.zones.some((z) => z.capacity.some((c) => c.dimension !== 'PERSONS')) && (
              <ul className="flex flex-col gap-1 border-t border-divider pt-2 text-sm">
                {doc.zones
                  .filter((z) => z.capacity.some((c) => c.dimension !== 'PERSONS'))
                  .map((z) => (
                    <li key={z.code} className="flex justify-between gap-3">
                      <span className="text-ink-muted">{z.name}</span>
                      <span className="text-right font-semibold">{capText(z)}</span>
                    </li>
                  ))}
              </ul>
            )}
          </div>

          <div className={`${CARD} gap-3.5`}>
            <h2 className={CARD_TITLE}>Añadir en {d.name}</h2>
            {targets.length > 0 && (
              <>
                <Labeled label="En la zona">
                  <select
                    className={INPUT}
                    value={target?.code ?? ''}
                    onChange={(e) => setTargetCode(e.target.value)}
                  >
                    {targets.map((z) => (
                      <option key={z.code} value={z.code}>
                        {z.name}
                      </option>
                    ))}
                  </select>
                </Labeled>
                <p className="-mt-1 text-[0.8125rem] leading-[1.125rem] text-ink-muted">
                  Una zona de pasajeros admite asientos, camarotes y camas mezclados; cada uno se vende con su
                  propia clase de precio.
                </p>
              </>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-bold">Asientos</legend>
              <div className="grid grid-cols-3 gap-2">
                <Labeled label="Izquierda">
                  <select className={INPUT} value={seatL} onChange={(e) => setSeatL(Number(e.target.value))}>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </Labeled>
                <Labeled label="Derecha">
                  <select className={INPUT} value={seatR} onChange={(e) => setSeatR(Number(e.target.value))}>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </Labeled>
                <Labeled label="Filas">
                  <input
                    className={INPUT}
                    type="number"
                    min={1}
                    max={30}
                    value={rows}
                    onChange={(e) => setRows(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
                  />
                </Labeled>
              </div>
              <button
                type="button"
                className={`${SECONDARY} justify-start text-sm`}
                onClick={withTarget((z) => addSeatRows(doc, z, [seatL, seatR], rows))}
              >
                Añadir {rows} {rows === 1 ? 'fila' : 'filas'} {seatL} + {seatR}
              </button>
              <button
                type="button"
                className={`${SECONDARY} justify-start text-sm`}
                onClick={withTarget((z) => addSeat(doc, z))}
              >
                Añadir un asiento individual
              </button>
              <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
                {target
                  ? `Las filas se centran en ${target.name} con un pasillo de 1 m, debajo de las que ya hay. Combina filas de 2 y de 3.`
                  : noTarget}
              </p>
            </fieldset>
            <fieldset className="flex flex-col gap-2 border-t border-divider pt-3">
              <legend className="float-left mb-2 text-sm font-bold">Camarotes y camas</legend>
              <div className="clear-both flex items-end gap-2">
                <Labeled label="Camas">
                  <select className={INPUT} value={beds} onChange={(e) => setBeds(Number(e.target.value))}>
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </Labeled>
                <button
                  type="button"
                  className={`${SECONDARY} flex-1 text-sm`}
                  onClick={withTarget((z) => addCabin(doc, z, beds))}
                >
                  Añadir camarote
                </button>
              </div>
              <button
                type="button"
                className={`${SECONDARY} justify-start text-sm`}
                onClick={withTarget((z) => addBed(doc, z))}
              >
                Añadir cama suelta
              </button>
              <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
                Cada cama mide 1 × 2 m. Un camarote con camas se puede vender completo o cama por cama.
              </p>
            </fieldset>
            <fieldset className="flex flex-col gap-2 border-t border-divider pt-3">
              <legend className="float-left mb-2 text-sm font-bold">Crear zona</legend>
              <div className="clear-both grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2">
                <Labeled label="Tipo">
                  <select
                    className={INPUT}
                    value={zoneKind}
                    onChange={(e) => setZoneKind(e.target.value as NewZoneKind)}
                  >
                    {(Object.keys(NEW_ZONE_KINDS) as NewZoneKind[]).map((k) => (
                      <option key={k} value={k}>
                        {NEW_ZONE_KINDS[k].label}
                      </option>
                    ))}
                  </select>
                </Labeled>
                <Labeled label="Largo (m)">
                  <input
                    className={INPUT}
                    type="number"
                    min={1}
                    step={0.25}
                    value={zoneLen}
                    onChange={(e) => setZoneLen(e.target.value)}
                  />
                </Labeled>
              </div>
              <button
                type="button"
                className={`${SECONDARY} justify-start text-sm`}
                onClick={() => apply(addZone(doc, deck, zoneKind, Number(zoneLen.replace(',', '.')) || 1))}
              >
                Crear la zona en {d.name}
              </button>
              <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
                Ocupa todo el ancho del piso en el primer tramo libre; luego ajusta su tamaño, su posición y
                su capacidad.
              </p>
            </fieldset>
          </div>
        </section>

        {/* Centro: el plano. */}
        <section
          aria-labelledby="h-plano"
          className={`${CARD} w-full min-w-0 min-[1100px]:h-full min-[1100px]:min-h-0 min-[1100px]:flex-1`}
        >
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 id="h-plano" className={CARD_TITLE}>
              Plano
            </h2>
            <div role="group" aria-label="Tamaño de la vista" className="flex gap-1.5">
              {ZOOMS.map((z) => (
                <button
                  key={z.id}
                  type="button"
                  aria-pressed={zoom === z.id}
                  onClick={() => setZoom(z.id)}
                  className={`inline-flex min-h-10 items-center rounded-full border px-3 text-[0.8125rem] font-semibold ${
                    zoom === z.id
                      ? 'border-ink bg-ink text-canvas'
                      : 'border-control bg-raised text-ink hover:bg-ink/5'
                  }`}
                >
                  {z.label}
                </button>
              ))}
            </div>
          </div>
          <div
            role="tablist"
            aria-label="Pisos"
            className="flex flex-wrap border-b border-divider"
            onKeyDown={(ev) => {
              const step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
              if (!step) return;
              ev.preventDefault();
              const next = (deck + step + doc.decks.length) % doc.decks.length;
              setDeck(next);
              document.getElementById(`piso-${next}`)?.focus();
            }}
          >
            {doc.decks.map((x, i) => (
              <button
                key={x.index}
                id={`piso-${i}`}
                type="button"
                role="tab"
                aria-selected={i === deck}
                aria-controls="panel-plano"
                tabIndex={i === deck ? 0 : -1}
                onClick={() => setDeck(i)}
                className={`-mb-px inline-flex min-h-11 items-center border-b-[3px] px-3.5 text-sm whitespace-nowrap ${
                  i === deck
                    ? 'border-ink font-bold text-ink'
                    : 'border-transparent font-semibold text-ink-muted hover:text-ink'
                }`}
              >
                {x.name}
              </button>
            ))}
          </div>
          <p id="ayuda-plano" className="text-[0.8125rem] leading-[1.125rem]">
            Flechas: ir de un elemento a otro. Enter: tomar el elemento; flechas para moverlo; Enter para
            dejarlo o Esc para devolverlo. Supr lo quita. Ctrl+Z deshace.
          </p>
          <div
            className="max-h-[45rem] overflow-auto rounded-[var(--radius-control)] bg-canvas p-1.5 min-[1100px]:max-h-none min-[1100px]:min-h-0 min-[1100px]:flex-1"
            tabIndex={-1}
          >
            <div
              id="panel-plano"
              role="tabpanel"
              aria-labelledby={`piso-${deck}`}
              ref={plane}
              onKeyDown={onPlaneKey}
              className="relative rounded border border-control bg-raised"
              style={{
                width: g.cols * C,
                height: g.rows * C,
                backgroundImage:
                  'linear-gradient(var(--divider) 1px, transparent 1px), linear-gradient(90deg, var(--divider) 1px, transparent 1px)',
                backgroundSize: `${C}px ${C}px`,
              }}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 z-[1] text-center text-[0.6875rem] font-bold tracking-[0.08em] text-ink-muted uppercase"
              >
                Proa
              </span>
              {deckZones.map((z) => {
                const on = selZone?.code === z.code;
                return (
                  <div
                    key={z.code}
                    className={`absolute rounded-md ${zoneTone(z)} ${on ? 'border-[3px] border-ink' : 'border border-dashed'}`}
                    style={{
                      left: z.rect.x * C,
                      top: z.rect.y * C,
                      width: z.rect.w * C,
                      height: z.rect.h * C,
                    }}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setSel({ type: 'zone', code: z.code })}
                      aria-label={`Zona ${z.name}${z.capacity.length ? `, ${capText(z)}` : ''}`}
                      className={`absolute bottom-1 left-1 z-[4] min-h-6 rounded-md px-2 text-xs font-semibold ${
                        on ? 'bg-ink text-canvas' : 'bg-raised/90 text-ink'
                      }`}
                    >
                      {z.name}
                    </button>
                  </div>
                );
              })}
              <div
                role="group"
                aria-label={`Elementos de ${d.name}, ${g.cols} columnas por ${g.rows} filas`}
                aria-describedby="ayuda-plano"
              >
                {deckEls.map((e) => {
                  const on = current?.code === e.code;
                  const grabbed = grab?.code === e.code;
                  const bedInCabin = e.kind === 'BED' && !!e.parentCode;
                  const label = e.kind === 'LABEL';
                  const tone = on
                    ? 'border-ink bg-ink text-canvas'
                    : e.kind === 'CABIN'
                      ? 'border-2 border-action bg-action/25 text-ink'
                      : label
                        ? 'border-transparent bg-transparent text-ink-muted uppercase'
                        : e.kind === 'SEAT' || e.kind === 'BED'
                          ? 'border-action bg-raised text-ink'
                          : 'border-control bg-ink/10 text-ink';
                  const inset = bedInCabin ? Math.round(C * 0.9) : 0;
                  return (
                    <button
                      key={e.code}
                      type="button"
                      data-code={e.code}
                      tabIndex={e.code === tabStop ? 0 : -1}
                      aria-pressed={on}
                      aria-label={`${elementTitle(e)}, columna ${e.x + 1}, fila ${e.y + 1}${grabbed ? ', tomado: muévelo con las flechas' : ''}`}
                      onClick={() => setSel({ type: 'element', code: e.code })}
                      onFocus={() => {
                        if (!on) setSel({ type: 'element', code: e.code });
                      }}
                      className={`absolute flex justify-center rounded border font-semibold ${
                        e.kind === 'CABIN' ? 'items-start pt-0.5' : 'items-center'
                      } ${tone} ${grabbed ? 'shadow-[0_0_0_2px_var(--surface-raised),0_0_0_5px_var(--text-primary)]' : ''}`}
                      style={{
                        left: e.x * C + 1 + (bedInCabin ? 2 : 0),
                        top: e.y * C + 1 + inset,
                        width: e.w * C - 2 - (bedInCabin ? 4 : 0),
                        height: e.h * C - 2 - inset - (bedInCabin ? 2 : 0),
                        zIndex: e.kind === 'CABIN' ? 2 : label ? 1 : 3,
                        fontSize: C >= 20 ? 12 : 10,
                      }}
                    >
                      {bedInCabin ? e.code.split('-').pop() : label ? e.label : e.code}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <p aria-live="polite" className="min-h-5 text-sm font-semibold">
            {announce}
          </p>
        </section>

        {/* Columna derecha: propiedades y «Antes de publicar». */}
        <section
          aria-labelledby="h-prop"
          className="flex w-full flex-col gap-4 min-[1100px]:h-full min-[1100px]:w-[20rem] min-[1100px]:shrink-0 min-[1100px]:overflow-y-auto min-[1100px]:overscroll-contain min-[1100px]:pr-1.5 min-[1100px]:pb-4"
        >
          <div className={CARD}>
            {selZone ? (
              <ZoneProps doc={doc} zone={selZone} commit={commit} apply={apply} />
            ) : current ? (
              <ElementProps doc={doc} el={current} commit={commit} apply={apply} />
            ) : (
              <>
                <h2 id="h-prop" className={CARD_TITLE}>
                  {d.name}
                </h2>
                <p className="text-sm">
                  Elige un elemento o una zona del plano para ver y cambiar sus datos.
                </p>
              </>
            )}
          </div>

          {toast && (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[0.625rem] bg-rail px-3.5 py-3 text-sm text-on-rail"
            >
              <span>{toast}</span>
              <button
                type="button"
                onClick={undo}
                className="min-h-10 rounded-[var(--radius-control)] border border-rail-highlight px-3 font-semibold text-rail-highlight"
              >
                Deshacer
              </button>
            </div>
          )}

          <div
            ref={issuesBox}
            tabIndex={-1}
            className={`flex flex-col gap-2.5 rounded-xl p-4 ${issues.length ? 'border border-danger/40 bg-danger-surface' : 'border border-divider bg-raised'}`}
          >
            <h2 className={CARD_TITLE}>{issues.length ? 'Antes de publicar' : 'Listo para publicar'}</h2>
            {issues.length ? (
              <ul className="flex list-disc flex-col gap-1.5 pl-[1.125rem] text-sm leading-5">
                {issues.map((i) => (
                  <li key={`${i.path}:${i.message}`}>
                    <button
                      type="button"
                      onClick={() => goIssue(i.path)}
                      className="text-left font-semibold text-danger underline underline-offset-[3px]"
                    >
                      {i.message}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm leading-5">
                Cumple todas las reglas. Al publicarla no cambia nada en los vehículos: asígnala desde{' '}
                <Link href="/panel/flota" className={LINK}>
                  Flota
                </Link>
                .
              </p>
            )}
          </div>
        </section>
      </div>

      {confirming && (
        <Dialog
          title={`¿Publicar la versión ${detail.version}?`}
          onRequestClose={() => {
            if (!publishing) setConfirming(false);
          }}
        >
          {publishError && <Alert>{publishError}</Alert>}
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[0.9375rem] leading-[1.375rem]">
            <li>
              {doc.decks.length} {doc.decks.length === 1 ? 'piso' : 'pisos'}: {inventory.summary.seats}{' '}
              asientos, {inventory.summary.cabins} camarotes, {inventory.summary.beds} camas y{' '}
              {inventory.summary.pooledPersons} personas en zonas libres
              {doc.totalPersons ? `; aforo de ${doc.totalPersons}` : ''}.
            </li>
          </ul>
          <p className="rounded-[var(--radius-control)] bg-ink/5 px-3.5 py-3 text-sm leading-5">
            Una versión publicada ya no cambia. Los viajes ya vendidos conservan la versión con la que se
            vendieron; esta se usará en los vehículos a los que la asignes desde Flota, a partir de la fecha
            que elijas.
          </p>
          <div className="flex flex-wrap justify-end gap-3">
            <button
              type="button"
              className={SECONDARY}
              onClick={() => setConfirming(false)}
              disabled={publishing}
            >
              Seguir editando
            </button>
            <button
              type="button"
              className={PRIMARY}
              onClick={() => void publish()}
              disabled={publishing}
              aria-busy={publishing || undefined}
            >
              {publishing ? 'Publicando…' : `Publicar la versión ${detail.version}`}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// --- Propiedades ----------------------------------------------------------------------------------------------------

type Commit = (next: LayoutDocument, message: string, select?: Selection, withToast?: boolean) => void;
type Apply = (r: Result, withToast?: boolean) => void;

function ZoneProps({
  doc,
  zone,
  commit,
  apply,
}: {
  doc: LayoutDocument;
  zone: LayoutZone;
  commit: Commit;
  apply: Apply;
}) {
  const rules = ZONE_RULES[zone.kind];
  const deck = doc.decks[zone.deck]!;
  const inside = doc.elements.filter((e) => e.zoneCode === zone.code).length;
  const reshape = (f: (r: LayoutZone['rect']) => LayoutZone['rect']) => apply(reshapeZone(doc, zone.code, f));
  return (
    <>
      <h2 id="h-prop" className={CARD_TITLE}>
        Zona · {zone.name}
      </h2>
      <p className="text-sm text-ink-muted">
        {ZONE_NAME[zone.kind]} ·{' '}
        {rules.mode === 'ASSIGNED'
          ? 'se vende por elementos: asientos, camarotes y camas, mezclados como quieras.'
          : 'se vende por cantidad en cada tramo del viaje.'}
      </p>
      <TextInput
        label="Nombre"
        value={zone.name}
        maxLength={60}
        onCommit={(v) =>
          v.trim() &&
          commit(
            { ...doc, zones: doc.zones.map((z) => (z.code === zone.code ? { ...z, name: v.trim() } : z)) },
            `Zona renombrada: ${v.trim()}`,
          )
        }
      />
      {rules.services.length > 1 && (
        <Labeled label="Servicio">
          <select
            className={INPUT}
            value={zone.service}
            onChange={(e) =>
              commit(
                updateZone(doc, zone.code, { service: e.target.value as LayoutZone['service'] }),
                `Servicio: ${SERVICE_NAME[e.target.value as keyof typeof SERVICE_NAME]}`,
              )
            }
          >
            {rules.services.map((s) => (
              <option key={s} value={s}>
                {SERVICE_NAME[s]}
              </option>
            ))}
          </select>
        </Labeled>
      )}
      {rules.dimensions.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">
            Capacidad {rules.needsCapacity ? '' : '(opcional)'}
          </legend>
          {CAPACITY_DIMENSIONS.filter((dim) => rules.dimensions.includes(dim)).map((dim) => (
            <NumberInput
              key={dim}
              inline
              label={DIM_LABEL[dim]}
              value={zone.capacity.find((c) => c.dimension === dim)?.value ?? null}
              min={0}
              max={10_000_000}
              decimal={dim !== 'PERSONS' && dim !== 'UNITS'}
              onCommit={(v) =>
                commit(
                  setZoneCapacity(doc, zone.code, dim, v),
                  `${zone.name}: ${DIM_LABEL[dim].toLowerCase()} ${v ?? 'sin indicar'}`,
                )
              }
            />
          ))}
        </fieldset>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">
          Tamaño · {meters(zone.rect.w, doc.cellCm)} × {meters(zone.rect.h, doc.cellCm)}
        </legend>
        <div className="grid grid-cols-[minmax(0,1fr)_2.75rem_2.75rem] items-center gap-1.5 text-sm">
          <span>Ancho</span>
          <IconButton label="Estrechar la zona" onClick={() => reshape((r) => ({ ...r, w: r.w - 1 }))}>
            −
          </IconButton>
          <IconButton label="Ensanchar la zona" onClick={() => reshape((r) => ({ ...r, w: r.w + 1 }))}>
            +
          </IconButton>
          <span>Largo</span>
          <IconButton label="Acortar la zona" onClick={() => reshape((r) => ({ ...r, h: r.h - 1 }))}>
            −
          </IconButton>
          <IconButton label="Alargar la zona" onClick={() => reshape((r) => ({ ...r, h: r.h + 1 }))}>
            +
          </IconButton>
        </div>
      </fieldset>
      <Arrows
        legend={`Posición · columna ${zone.rect.x + 1}, fila ${zone.rect.y + 1}`}
        noun="la zona"
        onMove={(dx, dy) => reshape((r) => ({ ...r, x: r.x + dx, y: r.y + dy }))}
      />
      <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
        Dentro de {deck.name} ({fmtNumber(deck.widthM)} × {fmtNumber(deck.lengthM)} m): la zona se detiene en
        el borde. Si se solapa con otra o deja fuera algún elemento, aparece en «Antes de publicar».
      </p>
      {inside === 0 ? (
        <button
          type="button"
          className="inline-flex min-h-11 items-center self-start px-2 text-sm font-semibold text-danger underline underline-offset-4"
          onClick={() =>
            commit(
              { ...doc, zones: doc.zones.filter((z) => z.code !== zone.code) },
              `Se quitó la zona ${zone.name}`,
              { type: 'none' },
              true,
            )
          }
        >
          Quitar la zona {zone.name}
        </button>
      ) : (
        <p className="text-[0.8125rem] text-ink-muted">
          Tiene {inside} {inside === 1 ? 'elemento' : 'elementos'}: quítalos para poder quitar la zona.
        </p>
      )}
    </>
  );
}

function ElementProps({
  doc,
  el,
  commit,
  apply,
}: {
  doc: LayoutDocument;
  el: LayoutElement;
  commit: Commit;
  apply: Apply;
}) {
  const zone = doc.zones.find((z) => z.code === el.zoneCode);
  const beds = doc.elements.filter((e) => e.parentCode === el.code);
  const where =
    el.kind === 'SEAT'
      ? `${zone?.name ?? 'Sin zona'} · 1 persona`
      : el.kind === 'CABIN'
        ? `${zone?.name ?? 'Sin zona'} · ${beds.length} ${beds.length === 1 ? 'cama' : 'camas'}, para ${el.capacity}`
        : el.kind === 'BED'
          ? el.parentCode
            ? `Dentro del camarote ${el.parentCode}`
            : `${zone?.name ?? 'Sin zona'} · se vende sola`
          : 'No se vende: sirve para orientarse en el plano.';
  return (
    <>
      <h2 id="h-prop" className={CARD_TITLE}>
        {elementTitle(el)}
      </h2>
      <p className="text-sm text-ink-muted">{where}</p>
      {el.kind === 'BED' && (
        <Labeled label="Personas en la cama">
          <select
            className={INPUT}
            value={el.capacity}
            onChange={(e) =>
              commit(
                updateElement(doc, el.code, { capacity: Number(e.target.value) }),
                `${el.code}: para ${e.target.value}`,
              )
            }
          >
            <option value={1}>1 (individual)</option>
            <option value={2}>2 (compartida)</option>
          </select>
        </Labeled>
      )}
      {el.kind === 'CABIN' && beds.length > 0 && (
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[0.9375rem]">
          <input
            type="checkbox"
            className="size-5 shrink-0"
            checked={el.sellableAsUnit}
            onChange={(e) =>
              commit(
                updateElement(doc, el.code, { sellableAsUnit: e.target.checked }),
                e.target.checked
                  ? `${el.code} se puede vender completo`
                  : `${el.code} se vende solo cama por cama`,
              )
            }
          />
          También se vende completo
        </label>
      )}
      {(el.kind === 'LABEL' || el.kind === 'OTHER') && (
        <TextInput
          label="Texto"
          value={el.label ?? ''}
          maxLength={40}
          onCommit={(v) => commit(updateElement(doc, el.code, { label: v.trim() || null }), 'Texto cambiado')}
        />
      )}
      {['SEAT', 'BED', 'CABIN', 'VEHICLE_SLOT'].includes(el.kind) && (
        <TextInput
          label="Clase de precio (opcional)"
          value={el.priceClassCode ?? ''}
          maxLength={24}
          hint={`Vacía: ${el.kind === 'BED' ? 'CAMA' : el.kind === 'CABIN' ? 'CAMAROTE' : (zone?.priceClassCode ?? (zone?.kind === 'VIP' ? 'VIP' : 'GENERAL'))}.`}
          upper
          onCommit={(v) => {
            const code = v.trim().toUpperCase();
            if (code && !/^[A-Z][A-Z0-9_]{1,23}$/.test(code))
              return 'Usa mayúsculas, números o guion bajo (p. ej., VIP, CAMA_DOBLE)';
            commit(
              updateElement(doc, el.code, { priceClassCode: code || null }),
              code ? `${el.code}: clase ${code}` : `${el.code}: clase por defecto`,
            );
            return null;
          }}
        />
      )}
      {!(el.kind === 'BED' && el.parentCode) && (
        <Arrows
          legend={`Posición · columna ${el.x + 1}, fila ${el.y + 1}`}
          noun={el.code}
          onMove={(dx, dy) => apply(moveElement(doc, el.code, dx, dy))}
        />
      )}
      <button
        type="button"
        className="inline-flex min-h-11 items-center self-start px-2 text-sm font-semibold text-danger underline underline-offset-4"
        onClick={() => apply(removeElement(doc, el.code), true)}
      >
        {el.kind === 'CABIN' && beds.length
          ? `Quitar el camarote ${el.code} y sus camas`
          : `Quitar ${el.code}`}
      </button>
    </>
  );
}

// --- Controles ------------------------------------------------------------------------------------------------------

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[0.8125rem] font-medium">
      {label}
      {children}
    </label>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex size-11 items-center justify-center rounded-[var(--radius-control)] border border-control bg-raised text-lg font-bold hover:bg-ink/5"
    >
      {children}
    </button>
  );
}

const ARROWS = [
  { dx: 0, dy: -1, label: 'hacia la proa', path: 'm5 12.5 5-5 5 5' },
  { dx: 0, dy: 1, label: 'hacia la popa', path: 'm5 7.5 5 5 5-5' },
  { dx: -1, dy: 0, label: 'a la izquierda', path: 'm12.5 5-5 5 5 5' },
  { dx: 1, dy: 0, label: 'a la derecha', path: 'm7.5 5 5 5-5 5' },
];

function Arrows({
  legend,
  noun,
  onMove,
}: {
  legend: string;
  noun: string;
  onMove: (dx: number, dy: number) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="grid grid-cols-[repeat(4,2.75rem)] gap-1.5">
        {ARROWS.map((a) => (
          <IconButton key={a.label} label={`Mover ${noun} ${a.label}`} onClick={() => onMove(a.dx, a.dy)}>
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              aria-hidden="true"
              className="size-[1.125rem]"
            >
              <path d={a.path} />
            </svg>
          </IconButton>
        ))}
      </div>
    </fieldset>
  );
}

/** Texto que se aplica al salir del campo o con Enter (un solo paso de deshacer por edición). */
function TextInput({
  label,
  value,
  maxLength,
  hint,
  upper = false,
  onCommit,
}: {
  label: string;
  value: string;
  maxLength: number;
  hint?: string;
  upper?: boolean;
  onCommit: (v: string) => string | null | void | false | '';
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(value), [value]);
  const done = () => {
    if (draft === value) return;
    const r = onCommit(draft);
    setError(typeof r === 'string' && r ? r : null);
  };
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      <input
        className={`${INPUT} ${upper ? 'uppercase' : ''}`}
        value={draft}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            done();
          }
        }}
      />
      {(error || hint) && (
        <span
          className={`text-[0.8125rem] ${error ? 'font-semibold text-danger' : 'font-normal text-ink-muted'}`}
        >
          {error ?? hint}
        </span>
      )}
    </label>
  );
}

/** Medida en metros (múltiplos de 25 cm), aplicada al salir del campo. */
function MetersInput({
  label,
  value,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  max: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(String(value)), [value]);
  const done = () => {
    const v = Number(draft.replace(',', '.'));
    if (v === value) return setError(null);
    if (!(v >= 1 && v <= max) || !Number.isInteger(v * 4)) {
      setError(`Entre 1 y ${max} m, en múltiplos de 25 cm`);
      return;
    }
    setError(null);
    onCommit(v);
  };
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
      {label}
      <input
        className={INPUT}
        type="number"
        min={1}
        max={max}
        step={0.25}
        value={draft}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            done();
          }
        }}
      />
      {error && <span className="text-[0.8125rem] font-semibold text-danger">{error}</span>}
    </label>
  );
}

function NumberInput({
  label,
  value,
  min,
  max,
  hint,
  inline = false,
  decimal = false,
  onCommit,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  hint?: string;
  inline?: boolean;
  decimal?: boolean;
  onCommit: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState(value?.toString() ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(value?.toString() ?? ''), [value]);
  const done = () => {
    const t = draft.trim();
    const v = t === '' ? null : Number(t.replace(',', '.'));
    if (v === value) return setError(null);
    if (v !== null && (!(v >= min && v <= max) || (!decimal && !Number.isInteger(v)))) {
      setError(
        decimal ? `Entre ${min} y ${fmtNumber(max)}` : `Un número entero entre ${min} y ${fmtNumber(max)}`,
      );
      return;
    }
    setError(null);
    onCommit(v === 0 ? null : v);
  };
  return (
    <label
      className={`flex text-sm font-medium ${inline ? 'items-center justify-between gap-3' : 'flex-col gap-1.5'}`}
    >
      <span className={inline ? '' : 'font-semibold'}>{label}</span>
      <input
        className={`${INPUT} ${inline ? 'w-28 text-right' : ''}`}
        inputMode={decimal ? 'decimal' : 'numeric'}
        value={draft}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            done();
          }
        }}
      />
      {(error || hint) && !inline && (
        <span
          className={`text-[0.8125rem] leading-[1.125rem] ${error ? 'font-semibold text-danger' : 'font-normal text-ink-muted'}`}
        >
          {error ?? hint}
        </span>
      )}
      {error && inline && <span className="text-[0.8125rem] font-semibold text-danger">{error}</span>}
    </label>
  );
}
