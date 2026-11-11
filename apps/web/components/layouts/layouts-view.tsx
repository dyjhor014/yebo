'use client';

import {
  boatTemplate,
  busTemplate,
  emptyLayout,
  fastBoatTemplate,
  type InventorySummary,
  type Layout,
  type LayoutDocument,
  type LayoutVersionSummary,
  type Modality,
  type VehicleType,
} from '@yebo/contracts';
import { Dialog } from '@yebo/ui/dialog';
import { Alert, Input, LINK, PRIMARY, ScrollRegion, SECONDARY, Select } from '@yebo/ui/form';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { MODALITY_NAME } from '@/components/fleet/fleet-view';
import {
  Chip,
  Empty,
  LiveStatus,
  Loading,
  PAGE_BODY,
  PageHeader,
  ROW_ACTION,
  useLoad,
} from '@/components/panel/kit';
import { fleetApi, layoutsApi } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';

/** Capacidad en una línea: «36 asientos · 4 camarotes (8 camas) · 70 por cantidad · aforo 110». */
export function summaryText(s: InventorySummary): string {
  const parts = [
    s.seats > 0 && `${s.seats} ${s.seats === 1 ? 'asiento' : 'asientos'}`,
    s.cabins > 0 && `${s.cabins} ${s.cabins === 1 ? 'camarote' : 'camarotes'}`,
    s.beds > 0 && `${s.beds} ${s.beds === 1 ? 'cama' : 'camas'}`,
    s.vehicleSlots > 0 && `${s.vehicleSlots} espacios de vehículo`,
    s.pooledPersons > 0 && `${s.pooledPersons} personas en zonas libres`,
    s.totalPersons !== null && `aforo ${s.totalPersons}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Sin capacidad todavía';
}

function versionChip(v: LayoutVersionSummary) {
  if (v.status === 'PUBLISHED') return <Chip tone="ok">v{v.version} publicada</Chip>;
  if (v.status === 'DRAFT') return <Chip tone="warn">v{v.version} borrador</Chip>;
  return <Chip tone="none">v{v.version} archivada</Chip>;
}

type Data = { layouts: Layout[]; types: VehicleType[]; modalities: Modality[] };

/** Planos de la empresa (Fase 6.4b; API de la 6.3): versiones, capacidad y alta desde plantilla. */
export function LayoutsView({ modalities }: { modalities: Modality[] }) {
  const { data, error, reload } = useLoad<Data>(async () => {
    const [layouts, types] = await Promise.all([
      layoutsApi.list(),
      fleetApi.types().catch(() => ({ types: [] as VehicleType[], catalog: [] })),
    ]);
    return { layouts: layouts.layouts, types: types.types.filter((t) => !t.archived), modalities };
  });
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const router = useRouter();

  const act = async (key: string, run: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setActionError(null);
    try {
      await run();
      await reload();
      setStatus(done);
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const TH = 'px-4 py-3 text-left text-[0.8125rem] font-semibold text-ink-muted';
  const TD = 'px-4 py-3.5 align-top text-sm';
  const layouts = data?.layouts ?? [];

  return (
    <>
      <PageHeader
        title="Planos"
        subtitle="El plano de cada unidad: dónde va cada asiento, camarote o bodega y cuánto se puede vender."
        actions={
          <button
            type="button"
            className={PRIMARY}
            disabled={!data || modalities.length === 0}
            onClick={() => setCreating(true)}
          >
            Nuevo plano
          </button>
        }
      />
      <LiveStatus message={status} />
      <div className={PAGE_BODY}>
        {error && <Alert>{error}</Alert>}
        {actionError && <Alert>{actionError}</Alert>}
        {!data ? (
          !error && <Loading what="los planos" />
        ) : layouts.length === 0 ? (
          <Empty>
            Aún no hay planos. Crea el primero desde una plantilla (lancha de 3 pisos, lancha rápida o bus) o
            en blanco, con las medidas reales de la unidad.
          </Empty>
        ) : (
          <ScrollRegion label="Planos">
            <table className="w-full min-w-[52rem] border-collapse rounded-xl border border-divider bg-raised">
              <caption className="px-4 pt-4 text-left font-display text-lg font-extrabold">
                {layouts.length} {layouts.length === 1 ? 'plano' : 'planos'}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>
                    Plano
                  </th>
                  <th scope="col" className={TH}>
                    Capacidad
                  </th>
                  <th scope="col" className={TH}>
                    Versiones
                  </th>
                  <th scope="col" className={TH}>
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {layouts.map((l) => {
                  const published = l.versions
                    .filter((v) => v.status === 'PUBLISHED')
                    .sort((a, b) => b.version - a.version)[0];
                  const draft = l.versions.find((v) => v.status === 'DRAFT');
                  const shown = published ?? draft;
                  const assigned = l.versions.reduce((n, v) => n + v.assignedVehicles, 0);
                  return (
                    <tr key={l.id} className="border-t border-divider">
                      <td className={TD}>
                        <span className="flex flex-col gap-0.5">
                          <Link href={`/panel/planos/${l.id}`} className={`${LINK} text-[0.9375rem]`}>
                            {l.name}
                          </Link>
                          <span className="text-[0.8125rem] text-ink-muted">
                            {MODALITY_NAME[l.modality]} ·{' '}
                            {l.vehicleTypeName ? `tipo ${l.vehicleTypeName}` : 'cualquier tipo'}
                            {assigned > 0 &&
                              ` · asignado a ${assigned} ${assigned === 1 ? 'vehículo' : 'vehículos'}`}
                            {l.archived && ' · archivado'}
                          </span>
                        </span>
                      </td>
                      <td className={`${TD} text-ink-muted`}>
                        {shown ? (
                          <>
                            {summaryText(shown.summary)}
                            {!published && (
                              <span className="block text-[0.8125rem]">(borrador, sin publicar)</span>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={TD}>
                        <span className="flex flex-wrap gap-1.5">
                          {[...l.versions]
                            .sort((a, b) => b.version - a.version)
                            .slice(0, 3)
                            .map((v) => (
                              <span key={v.version}>{versionChip(v)}</span>
                            ))}
                        </span>
                      </td>
                      <td className={`${TD} text-right whitespace-nowrap`}>
                        <Link
                          href={`/panel/planos/${l.id}`}
                          className={ROW_ACTION}
                          aria-label={`Ver ${l.name}`}
                        >
                          Ver
                        </Link>
                        {draft && !l.archived && (
                          <button
                            type="button"
                            className={ROW_ACTION}
                            disabled={busy === l.id}
                            aria-label={`Publicar el borrador de ${l.name}`}
                            onClick={() =>
                              void act(
                                l.id,
                                () => layoutsApi.publish(l.id),
                                `${l.name}: versión ${draft.version} publicada`,
                              )
                            }
                          >
                            Publicar
                          </button>
                        )}
                        {(l.archived || assigned === 0) && (
                          <button
                            type="button"
                            className={ROW_ACTION}
                            disabled={busy === l.id}
                            aria-label={`${l.archived ? 'Restaurar' : 'Archivar'} ${l.name}`}
                            onClick={() =>
                              void act(
                                l.id,
                                () => (l.archived ? layoutsApi.restore(l.id) : layoutsApi.archive(l.id)),
                                `${l.name} ${l.archived ? 'restaurado' : 'archivado'}`,
                              )
                            }
                          >
                            {l.archived ? 'Restaurar' : 'Archivar'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollRegion>
        )}
        <p className="text-sm leading-5 text-ink-muted">
          Una versión publicada no cambia: los viajes ya vendidos conservan la suya. Para cambiar el plano,
          edita un borrador, publícalo como versión nueva y asígnalo a los vehículos desde{' '}
          <Link href="/panel/flota" className={LINK}>
            Flota
          </Link>
          .
        </p>
      </div>
      {creating && data && (
        <NewLayoutDialog
          modalities={modalities}
          types={data.types}
          onClose={() => setCreating(false)}
          onCreated={(id) => router.push(`/panel/planos/${id}`)}
        />
      )}
    </>
  );
}

type TemplateId = 'boat' | 'fast' | 'bus' | 'empty';
const TEMPLATES: {
  id: TemplateId;
  modality: Modality | null;
  name: string;
  detail: string;
  make: () => LayoutDocument;
}[] = [
  {
    id: 'boat',
    modality: 'RIVER',
    name: 'Lancha de 3 pisos',
    detail:
      'Piso 1 con camarotes, zona libre y cubierta de carga; piso 2 con 36 asientos 3+3; piso 3 con terraza; bodega.',
    make: boatTemplate,
  },
  {
    id: 'fast',
    modality: 'RIVER',
    name: 'Lancha rápida',
    detail: 'Un piso de 12 × 3 m con 40 asientos 2+2 y bodega de equipaje.',
    make: fastBoatTemplate,
  },
  {
    id: 'bus',
    modality: 'LAND',
    name: 'Bus 2+2',
    detail: '40 asientos en 10 filas con pasillo, bodega de equipaje y aforo de 40.',
    make: busTemplate,
  },
  {
    id: 'empty',
    modality: null,
    name: 'En blanco',
    detail: 'Un piso vacío con las medidas que indiques.',
    make: () => emptyLayout('RIVER'),
  },
];

function NewLayoutDialog({
  modalities,
  types,
  onClose,
  onCreated,
}: {
  modalities: Modality[];
  types: VehicleType[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [modality, setModality] = useState<Modality>(modalities.includes('RIVER') ? 'RIVER' : 'LAND');
  const list = TEMPLATES.filter((t) => t.modality === null || t.modality === modality);
  const [template, setTemplate] = useState<TemplateId>(list[0]!.id);
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState('');
  const [lengthM, setLengthM] = useState(modality === 'RIVER' ? '16' : '12');
  const [widthM, setWidthM] = useState(modality === 'RIVER' ? '5' : '2.5');
  const [cellCm, setCellCm] = useState<25 | 50>(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickModality = (m: Modality) => {
    setModality(m);
    setTemplate(m === 'RIVER' ? 'boat' : 'bus');
    setTypeId('');
    setLengthM(m === 'RIVER' ? '16' : '12');
    setWidthM(m === 'RIVER' ? '5' : '2.5');
  };

  const document = (): LayoutDocument => {
    if (template !== 'empty') return TEMPLATES.find((t) => t.id === template)!.make();
    const base = emptyLayout(modality, cellCm);
    const m = (s: string) => Number(s.replace(',', '.'));
    return { ...base, decks: [{ index: 0, name: 'Piso 1', lengthM: m(lengthM), widthM: m(widthM) }] };
  };

  return (
    <Dialog
      title="Nuevo plano"
      description="Empieza desde una plantilla o en blanco; después ajústalo en el editor."
      onRequestClose={onClose}
      wide
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const created = await layoutsApi.create({
              name,
              modality,
              vehicleTypeId: typeId || null,
              document: document(),
            });
            onCreated(created.layoutId);
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        {error && <Alert>{error}</Alert>}
        {modalities.length > 1 && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Modalidad</legend>
            <div className="flex gap-2">
              {modalities.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={m === modality}
                  onClick={() => pickModality(m)}
                  className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold ${
                    m === modality
                      ? 'border-ink bg-ink text-canvas'
                      : 'border-control bg-raised text-ink hover:bg-ink/5'
                  }`}
                >
                  {MODALITY_NAME[m]}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={60}
            placeholder={
              modality === 'RIVER' ? 'Por ejemplo, Lancha Ucayali 3 pisos' : 'Por ejemplo, Bus cama 36'
            }
          />
          <Select
            label="Tipo de vehículo (opcional)"
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
          >
            <option value="">Cualquier unidad {modality === 'RIVER' ? 'fluvial' : 'terrestre'}</option>
            {types
              .filter((t) => t.modality === modality)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </Select>
        </div>
        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2.5 text-sm font-medium">Empezar desde</legend>
          {list.map((t) => {
            const on = t.id === template;
            return (
              <label
                key={t.id}
                className={`flex cursor-pointer items-start gap-3 rounded-[0.625rem] px-4 py-3.5 ${
                  on ? 'border-2 border-ink bg-canvas' : 'border border-control hover:bg-ink/5'
                }`}
              >
                <input
                  type="radio"
                  name="plantilla"
                  checked={on}
                  onChange={() => setTemplate(t.id)}
                  className="mt-0.5 size-[1.125rem] shrink-0"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-[0.9375rem] font-semibold">{t.name}</span>
                  <span className="text-sm text-ink-muted">{t.detail}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        {template === 'empty' && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                label="Largo del piso 1 (m)"
                type="number"
                min={1}
                max={100}
                step={0.25}
                value={lengthM}
                onChange={(e) => setLengthM(e.target.value)}
                required
              />
              <Input
                label="Ancho (m)"
                type="number"
                min={1}
                max={30}
                step={0.25}
                value={widthM}
                onChange={(e) => setWidthM(e.target.value)}
                required
              />
              <Select
                label="Escala de la grilla"
                value={String(cellCm)}
                onChange={(e) => setCellCm(Number(e.target.value) as 25 | 50)}
              >
                <option value="50">50 cm por celda</option>
                <option value="25">25 cm por celda</option>
              </Select>
            </div>
            <p className="-mt-2 text-[0.8125rem] leading-[1.125rem] text-ink-muted">
              Con 50 cm, un asiento ocupa una celda; con 25 cm se colocan asientos y pasillos con más
              precisión. La escala no cambia después. Cada piso tiene sus propias medidas y se añaden pisos en
              el editor (hasta 6, bodega incluida).
            </p>
          </>
        )}
        {template !== 'empty' && (
          <p className="-mt-2 text-[0.8125rem] leading-[1.125rem] text-ink-muted">
            Las plantillas usan celdas de 50 cm; cambia las medidas y el contenido en el editor.
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className={PRIMARY} disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Creando…' : 'Crear plano'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
