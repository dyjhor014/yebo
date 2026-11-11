'use client';

import {
  deckGrid,
  type CapacityDimension,
  type Layout,
  type LayoutDocument,
  type LayoutVersionDetail,
  type ZoneKind,
} from '@yebo/contracts';
import { Alert, LINK, PRIMARY, Warning } from '@yebo/ui/form';
import Link from 'next/link';
import { useState } from 'react';
import { MODALITY_NAME } from '@/components/fleet/fleet-view';
import {
  CARD,
  CARD_TITLE,
  Chip,
  LiveStatus,
  Loading,
  PAGE_BODY,
  PageHeader,
  fmtNumber,
  useLoad,
} from '@/components/panel/kit';
import { layoutsApi } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';
import { summaryText } from './layouts-view';

export const ZONE_NAME: Record<ZoneKind, string> = {
  SEATING: 'Pasajeros (asientos y camarotes)',
  VIP: 'Pasajeros VIP',
  CABINS: 'Pasajeros (camarotes y camas)',
  FREE_ZONE: 'Zona libre',
  HAMMOCK: 'Hamacas',
  LUGGAGE: 'Equipaje',
  HOLD: 'Bodega',
  CARGO_DECK: 'Cubierta de carga',
  VEHICLE_DECK: 'Cubierta de vehículos',
};

/** Colores de zona con los roles del tema (sirven en claro y oscuro); el tipo también va escrito. */
const ZONE_FILL: Partial<Record<ZoneKind, string>> = {
  SEATING: 'var(--action-fill)',
  VIP: 'var(--action-fill)',
  CABINS: 'var(--state-warning)',
  HOLD: 'var(--text-secondary)',
  CARGO_DECK: 'var(--text-secondary)',
  LUGGAGE: 'var(--text-secondary)',
  VEHICLE_DECK: 'var(--text-secondary)',
};

const DIMENSION: Record<CapacityDimension, (v: number) => string> = {
  PERSONS: (v) => `${fmtNumber(v)} personas`,
  UNITS: (v) => `${fmtNumber(v)} bultos`,
  WEIGHT_KG: (v) => (v >= 1000 ? `${fmtNumber(v / 1000)} t` : `${fmtNumber(v)} kg`),
  VOLUME_M3: (v) => `${fmtNumber(v)} m³`,
  LINEAR_M: (v) => `${fmtNumber(v)} m lineales`,
};

const meters = (cells: number, cellCm: number) => `${fmtNumber((cells * cellCm) / 100)} m`;

/** Ficha de un plano (Fase 6.4b): pisos con medidas reales, zonas, capacidad y lo que falta para publicar. */
export function LayoutDetail({ id }: { id: string }) {
  const { data, error, reload } = useLoad<{ layout: Layout; detail: LayoutVersionDetail }>(async () => {
    const layout = (await layoutsApi.list()).layouts.find((l) => l.id === id);
    if (!layout) throw new Error('Ese plano no existe');
    const draft = layout.versions.find((v) => v.status === 'DRAFT');
    const latest = draft ?? [...layout.versions].sort((a, b) => b.version - a.version)[0]!;
    return { layout, detail: await layoutsApi.version(id, latest.version) };
  });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  if (!data) {
    return (
      <>
        <PageHeader
          title="Plano"
          subtitle={
            <Link href="/panel/planos" className={LINK}>
              Volver a Planos
            </Link>
          }
        />
        <div className={PAGE_BODY}>{error ? <Alert>{error}</Alert> : <Loading what="el plano" />}</div>
      </>
    );
  }
  const { layout, detail } = data;
  const doc = detail.document;
  const draft = detail.status === 'DRAFT';

  return (
    <>
      <PageHeader
        title={layout.name}
        subtitle={
          <>
            <Link href="/panel/planos" className={LINK}>
              Planos
            </Link>{' '}
            · {MODALITY_NAME[layout.modality]} · versión {detail.version}{' '}
            {draft ? '(borrador)' : detail.status === 'PUBLISHED' ? '(publicada)' : '(archivada)'} · celdas de{' '}
            {doc.cellCm} cm
          </>
        }
        actions={
          draft && (
            <button
              type="button"
              className={PRIMARY}
              disabled={busy || detail.issues.length > 0}
              aria-busy={busy || undefined}
              onClick={async () => {
                setBusy(true);
                setActionError(null);
                try {
                  await layoutsApi.publish(id);
                  await reload();
                  setStatus(`Versión ${detail.version} publicada`);
                } catch (e) {
                  setActionError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Publicando…' : `Publicar la versión ${detail.version}`}
            </button>
          )
        }
      />
      <LiveStatus message={status} />
      <div className={PAGE_BODY}>
        {actionError && <Alert>{actionError}</Alert>}
        <Warning>
          El editor del plano (añadir pisos, filas de asientos, camarotes y zonas, y cambiar sus medidas)
          llega en la siguiente entrega. Esta ficha muestra el plano tal como lo guarda YEBO.
        </Warning>
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex min-w-0 flex-[999_1_34rem] flex-col gap-4">
            {doc.decks.map((deck) => (
              <DeckCard key={deck.index} doc={doc} index={deck.index} />
            ))}
          </div>
          <aside className="flex min-w-0 flex-[1_1_18rem] flex-col gap-4">
            <section aria-labelledby="h-cap" className={CARD}>
              <h2 id="h-cap" className={CARD_TITLE}>
                Lo que se podrá vender
              </h2>
              <p className="text-sm leading-5">{summaryText(detail.inventory.summary)}</p>
              <ul className="flex flex-col gap-1 text-sm">
                {detail.inventory.pools
                  .filter((p) => p.scope === 'ZONE')
                  .map((p) => (
                    <li key={`${p.zoneCode}-${p.dimension}`} className="flex justify-between gap-3">
                      <span className="text-ink-muted">
                        {doc.zones.find((z) => z.code === p.zoneCode)?.name}
                      </span>
                      <span className="font-semibold">{DIMENSION[p.dimension](p.capacity)}</span>
                    </li>
                  ))}
              </ul>
            </section>
            {draft && (
              <section aria-labelledby="h-issues" className={CARD}>
                <h2 id="h-issues" className={CARD_TITLE}>
                  Antes de publicar
                </h2>
                {detail.issues.length === 0 ? (
                  <p className="text-sm">Todo en orden: se puede publicar.</p>
                ) : (
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-danger">
                    {detail.issues.map((i) => (
                      <li key={`${i.path}-${i.message}`}>{i.message}</li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </aside>
        </div>
      </div>
    </>
  );
}

function DeckCard({ doc, index }: { doc: LayoutDocument; index: number }) {
  const deck = doc.decks.find((d) => d.index === index)!;
  const grid = deckGrid(doc, deck);
  const zones = doc.zones.filter((z) => z.deck === index);
  const elements = doc.elements.filter((e) => e.deck === index);
  const unit = 12; // px por celda de 50 cm; a 25 cm, la mitad
  const px = (unit * doc.cellCm) / 50;
  const titleId = `deck-${index}`;
  return (
    <section aria-labelledby={titleId} className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={titleId} className={CARD_TITLE}>
          {deck.name}
        </h2>
        <span className="text-sm text-ink-muted">
          {fmtNumber(deck.lengthM)} m de largo × {fmtNumber(deck.widthM)} m de ancho · grilla de {grid.cols} ×{' '}
          {grid.rows} celdas
        </span>
      </div>
      <div className="flex flex-wrap items-start gap-5">
        <div
          className="max-h-[28rem] overflow-auto rounded-[var(--radius-control)] bg-canvas p-2"
          tabIndex={0}
          aria-label={`Plano de ${deck.name}`}
        >
          <svg
            width={grid.cols * px}
            height={grid.rows * px}
            viewBox={`0 0 ${grid.cols} ${grid.rows}`}
            role="img"
            aria-label={`${deck.name}: ${zones.length} zonas y ${elements.length} elementos; proa arriba.`}
            className="block"
          >
            <rect
              x={0}
              y={0}
              width={grid.cols}
              height={grid.rows}
              fill="var(--surface-raised)"
              stroke="var(--control-border-strong)"
              strokeWidth={0.08}
            />
            {zones.map((z) => (
              <rect
                key={z.code}
                x={z.rect.x}
                y={z.rect.y}
                width={z.rect.w}
                height={z.rect.h}
                fill={ZONE_FILL[z.kind] ?? 'var(--text-secondary)'}
                fillOpacity={0.14}
                stroke={ZONE_FILL[z.kind] ?? 'var(--text-secondary)'}
                strokeWidth={0.08}
                strokeDasharray="0.3 0.2"
              />
            ))}
            {elements.map((e) => (
              <rect
                key={e.code}
                x={e.x + 0.06}
                y={e.y + 0.06}
                width={e.w - 0.12}
                height={e.h - 0.12}
                rx={0.15}
                fill={
                  e.kind === 'CABIN'
                    ? 'none'
                    : e.kind === 'LABEL'
                      ? 'var(--surface-canvas)'
                      : 'var(--text-primary)'
                }
                fillOpacity={e.kind === 'BED' ? 0.55 : 0.85}
                stroke="var(--text-primary)"
                strokeWidth={e.kind === 'CABIN' ? 0.12 : 0.04}
              />
            ))}
          </svg>
        </div>
        <ul className="flex min-w-[14rem] flex-1 flex-col gap-2 text-sm">
          {zones.length === 0 && <li className="text-ink-muted">Este piso aún no tiene zonas.</li>}
          {zones.map((z) => {
            const n = elements.filter((e) => e.zoneCode === z.code);
            const seats = n.filter((e) => e.kind === 'SEAT').length;
            const cabins = n.filter((e) => e.kind === 'CABIN').length;
            const beds = n.filter((e) => e.kind === 'BED').length;
            return (
              <li key={z.code} className="flex flex-col gap-0.5 border-t border-divider pt-2">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{z.name}</span>
                  <Chip tone="none">{ZONE_NAME[z.kind]}</Chip>
                </span>
                <span className="text-[0.8125rem] text-ink-muted">
                  {meters(z.rect.w, doc.cellCm)} × {meters(z.rect.h, doc.cellCm)}
                  {z.capacity.length > 0 &&
                    ` · ${z.capacity.map((c) => DIMENSION[c.dimension](c.value)).join(' · ')}`}
                  {seats > 0 && ` · ${seats} asientos`}
                  {cabins > 0 && ` · ${cabins} camarotes`}
                  {beds > 0 && ` · ${beds} camas`}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
