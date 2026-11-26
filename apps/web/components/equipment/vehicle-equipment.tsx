'use client';

import {
  INSPECTION_DISCLAIMER,
  type EquipmentCatalogEntry,
  type EquipmentCategory,
  type EquipmentStatus,
  type InspectionSummary,
  type Trip,
  type Vehicle,
  type VehicleEquipment,
} from '@yebo/contracts';
import { Dialog } from '@yebo/ui/dialog';
import { Alert, Input, LINK, PRIMARY, SECONDARY, Select, Textarea } from '@yebo/ui/form';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  CARD,
  CARD_TITLE,
  Check,
  Chip,
  DialogActions,
  Empty,
  Loading,
  ROW_ACTION,
  today,
  useLoad,
} from '@/components/panel/kit';
import { usePanel } from '@/components/panel/panel-session';
import { addDays } from '@/components/trips/trip-kit';
import { equipmentApi, inspectionsApi, tripsApi } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';
import {
  CATEGORY_NAME,
  EQUIPMENT_STATUS,
  INSPECTION_STATUS,
  expiryOf,
  inspectorOf,
  whenOf,
} from './equipment-kit';

type Data = { equipment: VehicleEquipment[]; inspections: InspectionSummary[] };

/**
 * Equipamiento de la unidad e historial de inspecciones (Fase 7.5c; maqueta 7.5, pantalla 6). Opcional: una unidad
 * sin equipamiento es válida y nada de esto condiciona viajes ni ventas. Ver es `inspections.read`; declarar,
 * `equipment.manage`; inspeccionar, `inspections.perform`.
 */
export function VehicleEquipmentSection({
  vehicle: v,
  onStatus,
}: {
  vehicle: Vehicle;
  onStatus: (msg: string) => void;
}) {
  const { can } = usePanel();
  const canManage = can('equipment.manage');
  const canPerform = can('inspections.perform');
  const { data, error, reload } = useLoad<Data>(async () => {
    const [equipment, inspections] = await Promise.all([
      equipmentApi.forVehicle(v.id),
      inspectionsApi.forVehicle(v.id),
    ]);
    return { equipment: equipment.equipment, inspections: inspections.inspections };
  });
  const [dialog, setDialog] = useState<
    | { kind: 'catalog' }
    | { kind: 'item'; item: VehicleEquipment | null }
    | { kind: 'company' }
    | { kind: 'inspect' }
    | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const active = data?.equipment.filter((e) => !e.archived) ?? [];
  const after = async (msg: string) => {
    setDialog(null);
    await reload();
    onStatus(msg);
  };

  return (
    <>
      <section aria-labelledby="h-eq" className={CARD}>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="flex max-w-[34rem] flex-col gap-1">
            <h3 id="h-eq" className={CARD_TITLE}>
              Equipamiento de la unidad
            </h3>
            <span className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
              Opcional. Sirve de lista para las inspecciones; no condiciona viajes ni ventas.
            </span>
          </div>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={SECONDARY}
                disabled={!data}
                onClick={() => setDialog({ kind: 'item', item: null })}
              >
                Elemento propio
              </button>
              <button
                type="button"
                className={PRIMARY}
                disabled={!data}
                onClick={() => setDialog({ kind: 'catalog' })}
              >
                Agregar desde el catálogo
              </button>
            </div>
          )}
        </div>
        {error && <Alert>{error}</Alert>}
        {actionError && <Alert>{actionError}</Alert>}
        {!data ? (
          !error && <Loading what="el equipamiento" />
        ) : active.length === 0 ? (
          <Empty>
            Sin equipamiento declarado.{' '}
            {canManage
              ? 'Si quieres usar inspecciones, agrega los elementos que lleva esta unidad (chalecos, extintores, botiquín…).'
              : 'Nada que hacer: es opcional.'}
          </Empty>
        ) : (
          <ul aria-label={`Equipamiento declarado de ${v.name}`}>
            {active.map((e) => {
              const exp = expiryOf(e);
              return (
                <li
                  key={e.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-divider py-3"
                >
                  <span className="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5">
                    <span className="text-[0.9375rem] font-semibold">{e.name}</span>
                    <span className="text-[0.8125rem] text-ink-muted">
                      {CATEGORY_NAME[e.category]} · cantidad {e.quantity}
                      {e.serialNumber ? ` · serie ${e.serialNumber}` : ''}
                      {exp.tone === null && e.expiresOn ? ` · vence el ${exp.text}` : ''}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <Chip tone={EQUIPMENT_STATUS[e.status].tone}>{EQUIPMENT_STATUS[e.status].label}</Chip>
                    {exp.tone && <Chip tone={exp.tone}>{exp.text}</Chip>}
                    {canManage && (
                      <>
                        <button
                          type="button"
                          className={ROW_ACTION}
                          aria-label={`Editar ${e.name}`}
                          onClick={() => setDialog({ kind: 'item', item: e })}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className={ROW_ACTION}
                          aria-label={`Eliminar ${e.name} de la unidad`}
                          onClick={() => {
                            setActionError(null);
                            equipmentApi
                              .remove(v.id, e.id)
                              .then(() => after(`${e.name} eliminado de la unidad`))
                              .catch((err: unknown) => setActionError(errorMessage(err)));
                          }}
                        >
                          Eliminar
                        </button>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
          Eliminar quita el elemento de la unidad y de las próximas inspecciones; las anteriores lo conservan
          tal como se verificó.
          {canManage && (
            <>
              {' '}
              <button
                type="button"
                className={`${LINK} min-h-11`}
                onClick={() => setDialog({ kind: 'company' })}
              >
                Catálogo de la empresa
              </button>
            </>
          )}
        </p>
      </section>

      <section aria-labelledby="h-ins" className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="h-ins" className={CARD_TITLE}>
            Inspecciones
          </h3>
          {canPerform && (
            <button
              type="button"
              className={PRIMARY}
              disabled={!data || active.length === 0 || v.status === 'RETIRED'}
              aria-describedby={data && active.length === 0 ? 'ins-why' : undefined}
              onClick={() => setDialog({ kind: 'inspect' })}
            >
              Nueva inspección
            </button>
          )}
        </div>
        {data && active.length === 0 && canPerform && (
          <p id="ins-why" className="text-sm text-ink-muted">
            Para inspeccionar, primero declara el equipamiento de la unidad.
          </p>
        )}
        {data &&
          (data.inspections.length === 0 ? (
            <Empty>Aún no hay inspecciones de esta unidad.</Empty>
          ) : (
            <ul aria-label={`Historial de inspecciones de ${v.name}`}>
              {data.inspections.map((i) => (
                <InspectionRow key={i.id} inspection={i} all={data.inspections} />
              ))}
            </ul>
          ))}
        <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
          Una inspección completada no se edita: se corrige con una rectificación, y la original queda
          visible. {INSPECTION_DISCLAIMER}
        </p>
      </section>

      {dialog?.kind === 'catalog' && data && (
        <CatalogDialog
          vehicle={v}
          declared={active}
          onClose={() => setDialog(null)}
          onSaved={(n) => after(`${n} ${n === 1 ? 'elemento agregado' : 'elementos agregados'}`)}
        />
      )}
      {dialog?.kind === 'item' && (
        <ItemDialog
          vehicle={v}
          item={dialog.item}
          onClose={() => setDialog(null)}
          onSaved={(name) => after(`${name} guardado`)}
        />
      )}
      {dialog?.kind === 'company' && (
        <CompanyCatalogDialog onClose={() => setDialog(null)} onStatus={onStatus} />
      )}
      {dialog?.kind === 'inspect' && <NewInspectionDialog vehicle={v} onClose={() => setDialog(null)} />}
    </>
  );
}

function InspectionRow({ inspection: i, all }: { inspection: InspectionSummary; all: InspectionSummary[] }) {
  const st = INSPECTION_STATUS[i.status];
  const original = i.rectifiesId ? all.find((x) => x.id === i.rectifiesId) : null;
  const draft = i.status === 'DRAFT';
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-divider py-3">
      <span className="flex min-w-0 flex-[1_1_16rem] flex-col gap-0.5">
        <span className="text-[0.9375rem] font-semibold">
          {whenOf(i)} · {inspectorOf(i)}
        </span>
        <span className="text-[0.8125rem] text-ink-muted">
          {i.trip ? `Viaje ${i.trip.code}` : 'Sin viaje'}
          {i.counts &&
            ` · ${i.counts.conforming} conformes · ${i.counts.observed} observados · ${
              i.counts.notOperational + i.counts.notAvailable
            } no operativos o no disponibles`}
          {draft && ` · ${i.items} elementos`}
        </span>
        {(i.rectifiesId || i.rectifiedBy.length > 0) && (
          <span className="text-[0.8125rem] font-semibold">
            {i.rectifiesId
              ? `Rectifica la del ${original ? whenOf(original) : 'una anterior'}`
              : 'Rectificada'}
          </span>
        )}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <Chip tone={st.tone}>{st.label}</Chip>
        <Link
          href={`/panel/inspecciones/${i.id}`}
          className={ROW_ACTION}
          aria-label={`${draft ? 'Continuar' : 'Ver'} la inspección del ${whenOf(i)}`}
        >
          {draft ? 'Continuar' : 'Ver'}
        </Link>
      </span>
    </li>
  );
}

const STATUSES: EquipmentStatus[] = ['OPERATIVE', 'DETERIORATED', 'INOPERATIVE', 'UNVERIFIED'];
const CATEGORIES: EquipmentCategory[] = ['SAFETY', 'EMERGENCY', 'OPERATION'];

/** Las sugerencias del catálogo de YEBO y del de la empresa que sirven para la modalidad de la unidad. */
function CatalogDialog({
  vehicle: v,
  declared,
  onClose,
  onSaved,
}: {
  vehicle: Vehicle;
  declared: VehicleEquipment[];
  onClose: () => void;
  onSaved: (n: number) => Promise<void>;
}) {
  const catalog = useLoad(() => equipmentApi.catalog());
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = (e: EquipmentCatalogEntry) => `${e.source}:${e.ref}`;
  const isDeclared = (e: EquipmentCatalogEntry) =>
    declared.some((d) => (e.source === 'CATALOG' ? d.catalogCode === e.ref : d.tenantItemId === e.ref));
  const entries = (catalog.data?.entries ?? []).filter(
    (e) => !e.archived && (e.modality === null || e.modality === v.modality),
  );
  const count = Object.keys(picked).length;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const items = entries
        .filter((e) => picked[key(e)] !== undefined)
        .map((e) => ({
          name: e.name,
          category: e.category,
          quantity: Number(picked[key(e)]),
          description: null,
          status: 'UNVERIFIED' as const,
          expiresOn: null,
          serialNumber: null,
          catalogCode: e.source === 'CATALOG' ? e.ref : null,
          tenantItemId: e.source === 'TENANT' ? e.ref : null,
        }));
      await equipmentApi.add(v.id, { items });
      await onSaved(items.length);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Agregar desde el catálogo"
      description={`Sugerencias para ${v.modality === 'RIVER' ? 'una embarcación' : 'un vehículo terrestre'}. Quedan «sin verificar»: el estado, el vencimiento y la serie se completan con «Editar».`}
      onRequestClose={onClose}
      wide
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        {error && <Alert>{error}</Alert>}
        {catalog.error && <Alert>{catalog.error}</Alert>}
        {!catalog.data ? (
          !catalog.error && <Loading what="el catálogo" />
        ) : (
          <fieldset className="flex flex-col">
            <legend className="sr-only">Elementos del catálogo</legend>
            {entries.map((e) => {
              const k = key(e);
              const on = picked[k] !== undefined;
              const done = isDeclared(e);
              return (
                <div
                  key={k}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-divider py-2"
                >
                  <label className="flex min-h-11 flex-[1_1_16rem] cursor-pointer items-start gap-3 py-1.5">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-5 shrink-0"
                      aria-labelledby={`${k}-n`}
                      aria-describedby={`${k}-d`}
                      checked={on}
                      disabled={done}
                      onChange={(ev) =>
                        setPicked((p) => {
                          const next = { ...p };
                          if (ev.target.checked) next[k] = '1';
                          else delete next[k];
                          return next;
                        })
                      }
                    />
                    <span className="flex flex-col gap-0.5">
                      <span id={`${k}-n`} className="text-[0.9375rem] font-semibold">
                        {e.name}
                        {e.source === 'TENANT' && (
                          <span className="font-normal text-ink-muted"> · de tu empresa</span>
                        )}
                        {done && <span className="font-normal text-ink-muted"> · ya declarado</span>}
                      </span>
                      <span id={`${k}-d`} className="text-[0.8125rem] text-ink-muted">
                        {CATEGORY_NAME[e.category]}
                        {e.reference ? ` · ${e.reference}` : ''}
                      </span>
                    </span>
                  </label>
                  {on && (
                    <div className="w-28">
                      <Input
                        label={`Cantidad de ${e.name}`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={100000}
                        required
                        value={picked[k]}
                        onChange={(ev) => setPicked((p) => ({ ...p, [k]: ev.target.value }))}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>
        )}
        <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
          Las sugerencias no son obligatorias: lo exigible depende de tu servicio, de la unidad y de la norma
          vigente. {INSPECTION_DISCLAIMER}
        </p>
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className={PRIMARY}
            disabled={busy || count === 0}
            aria-busy={busy || undefined}
          >
            {busy ? 'Guardando…' : count > 0 ? `Agregar ${count}` : 'Agregar'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Un elemento escrito a mano (opcionalmente guardado en el catálogo de la empresa) o la edición de uno declarado. */
function ItemDialog({
  vehicle: v,
  item,
  onClose,
  onSaved,
}: {
  vehicle: Vehicle;
  item: VehicleEquipment | null;
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [category, setCategory] = useState<EquipmentCategory>(item?.category ?? 'SAFETY');
  const [quantity, setQuantity] = useState(String(item?.quantity ?? 1));
  const [status, setStatus] = useState<EquipmentStatus>(item?.status ?? 'OPERATIVE');
  const [expiresOn, setExpiresOn] = useState(item?.expiresOn ?? '');
  const [serial, setSerial] = useState(item?.serialNumber ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    const fields = {
      name: name.trim(),
      category,
      quantity: Number(quantity),
      description: description.trim() || null,
      status,
      expiresOn: expiresOn || null,
      serialNumber: serial.trim() || null,
    };
    try {
      if (item) {
        await equipmentApi.update(v.id, item.id, fields);
      } else {
        let tenantItemId: string | null = null;
        if (save) {
          const catalog = await equipmentApi.createItem({
            name: fields.name,
            modality: v.modality,
            category,
            tracksExpiry: fields.expiresOn !== null,
            tracksSerial: fields.serialNumber !== null,
            description: fields.description,
          });
          tenantItemId =
            catalog.entries.find((e) => e.source === 'TENANT' && e.name === fields.name)?.ref ?? null;
        }
        await equipmentApi.add(v.id, { items: [{ ...fields, catalogCode: null, tenantItemId }] });
      }
      await onSaved(fields.name);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={item ? `Editar ${item.name}` : 'Elemento propio'}
      description={item ? undefined : `Un elemento que lleva ${v.code} y no está en el catálogo.`}
      onRequestClose={onClose}
      wide
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={80}
          />
          <Select
            label="Categoría"
            value={category}
            onChange={(e) => setCategory(e.target.value as EquipmentCategory)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_NAME[c]}
              </option>
            ))}
          </Select>
          <Input
            label="Cantidad"
            type="number"
            inputMode="numeric"
            min={1}
            max={100000}
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
          <Select
            label="Estado"
            value={status}
            onChange={(e) => setStatus(e.target.value as EquipmentStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {EQUIPMENT_STATUS[s].label}
              </option>
            ))}
          </Select>
          <Input
            label="Vencimiento (opcional)"
            type="date"
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
          />
          <Input
            label="Número de serie (opcional)"
            value={serial}
            maxLength={60}
            onChange={(e) => setSerial(e.target.value)}
          />
        </div>
        <Textarea
          label="Descripción (opcional)"
          rows={2}
          maxLength={300}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {!item && (
          <Check label="Guardarlo también en el catálogo de la empresa" checked={save} onChange={setSave} />
        )}
        <DialogActions busy={busy} label={item ? 'Guardar' : 'Agregar'} onCancel={onClose} />
      </form>
    </Dialog>
  );
}

/** Catálogo propio de la empresa: los elementos guardados para reutilizarlos; se archivan, no se borran. */
function CompanyCatalogDialog({ onClose, onStatus }: { onClose: () => void; onStatus: (m: string) => void }) {
  const { data, error, setData } = useLoad(() => equipmentApi.catalog());
  const [actionError, setActionError] = useState<string | null>(null);
  const own = (data?.entries ?? []).filter((e) => e.source === 'TENANT');
  return (
    <Dialog
      title="Catálogo de la empresa"
      description="Tus elementos propios, para agregarlos a cualquier unidad. Se crean con «Elemento propio»."
      onRequestClose={onClose}
      wide
    >
      {error && <Alert>{error}</Alert>}
      {actionError && <Alert>{actionError}</Alert>}
      {!data ? (
        !error && <Loading what="el catálogo" />
      ) : own.length === 0 ? (
        <Empty>
          Aún no hay elementos propios. Al agregar un «Elemento propio», marca «Guardarlo también en el
          catálogo de la empresa».
        </Empty>
      ) : (
        <ul>
          {own.map((e) => (
            <li
              key={e.ref}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-divider py-2.5"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-[0.9375rem] font-semibold">{e.name}</span>
                <span className="text-[0.8125rem] text-ink-muted">
                  {CATEGORY_NAME[e.category]}
                  {e.modality === null
                    ? ' · general'
                    : e.modality === 'RIVER'
                      ? ' · fluvial'
                      : ' · terrestre'}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {e.archived && <Chip tone="none">Archivado</Chip>}
                <button
                  type="button"
                  className={ROW_ACTION}
                  aria-label={`${e.archived ? 'Restaurar' : 'Archivar'} ${e.name}`}
                  onClick={() => {
                    setActionError(null);
                    (e.archived ? equipmentApi.restoreItem(e.ref) : equipmentApi.archiveItem(e.ref))
                      .then((r) => {
                        setData(r);
                        onStatus(`${e.name} ${e.archived ? 'restaurado' : 'archivado'}`);
                      })
                      .catch((err: unknown) => setActionError(errorMessage(err)));
                  }}
                >
                  {e.archived ? 'Restaurar' : 'Archivar'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
        Archivar lo quita de las sugerencias; las unidades que ya lo tienen lo conservan.
      </p>
      <div className="flex justify-end">
        <button type="button" className={SECONDARY} onClick={onClose}>
          Cerrar
        </button>
      </div>
    </Dialog>
  );
}

/** Nueva inspección (borrador): con o sin viaje; al crearla abre la pantalla de inspección. */
function NewInspectionDialog({ vehicle: v, onClose }: { vehicle: Vehicle; onClose: () => void }) {
  const { can } = usePanel();
  const router = useRouter();
  // `list: null`: el acceso no incluye los viajes (distinto de «cargando», que es `data: null`).
  const trips = useLoad<{ list: Trip[] | null }>(async () => {
    if (!can('trips.manage')) return { list: null };
    const t = today();
    const r = await tripsApi.list({ from: addDays(t, -1), to: addDays(t, 7) });
    return { list: r.trips.filter((x) => x.vehicle?.id === v.id && x.status !== 'CANCELLED') };
  });
  const [tripId, setTripId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={`Nueva inspección de ${v.code}`}
      description="Se carga el equipamiento declarado de hoy. Puedes salir y seguir después: el borrador se guarda."
      onRequestClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          inspectionsApi
            .create({ vehicleId: v.id, tripId: tripId || null, rectifiesId: null, rectificationReason: null })
            .then((i) => router.push(`/panel/inspecciones/${i.id}`))
            .catch((err: unknown) => {
              setError(errorMessage(err));
              setBusy(false);
            });
        }}
      >
        {error && <Alert>{error}</Alert>}
        {trips.error && <Alert>{trips.error}</Alert>}
        {!trips.data ? (
          !trips.error && <Loading what="los viajes de la unidad" />
        ) : trips.data.list === null ? (
          <p className="text-sm text-ink-muted">
            Tu acceso no incluye los viajes: la inspección queda sin viaje.
          </p>
        ) : (
          <Select
            label="Viaje (opcional)"
            value={tripId}
            onChange={(e) => setTripId(e.target.value)}
            hint="Los de esta unidad entre ayer y los próximos 7 días."
          >
            <option value="">Sin viaje (por ejemplo, inicio de jornada)</option>
            {trips.data.list.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} · {t.routeName}
              </option>
            ))}
          </Select>
        )}
        <DialogActions busy={busy} label="Empezar inspección" onCancel={onClose} />
      </form>
    </Dialog>
  );
}
