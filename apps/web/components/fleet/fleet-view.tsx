'use client';

import {
  VEHICLE_STATUSES,
  type Layout,
  type LayoutAssignment,
  type Modality,
  type Vehicle,
  type VehicleDocument,
  type VehicleDocumentsResponse,
  type VehicleStatus,
  type VehicleType,
  type VehicleTypesResponse,
} from '@yebo/contracts';
import { Dialog } from '@yebo/ui/dialog';
import { Alert, Input, LINK, PRIMARY, SECONDARY, Select } from '@yebo/ui/form';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
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
  daysUntil,
  fmtDate,
  fmtNumber,
  today,
  useLoad,
  type ChipTone,
} from '@/components/panel/kit';
import { VehicleEquipmentSection } from '@/components/equipment/vehicle-equipment';
import { usePanel } from '@/components/panel/panel-session';
import { DOCUMENT_FILE_TYPES, fleetApi, layoutsApi, uploadDocumentFile } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';

export const MODALITY_NAME: Record<Modality, string> = { RIVER: 'Fluvial', LAND: 'Terrestre' };
const STATUS_NAME: Record<VehicleStatus, string> = {
  ACTIVE: 'Activo',
  MAINTENANCE: 'En mantenimiento',
  OUT_OF_SERVICE: 'Fuera de servicio',
  RETIRED: 'Retirado',
};
const SUMMARY: Record<Vehicle['documents'], { tone: ChipTone; label: string }> = {
  OK: { tone: 'ok', label: 'Documentos al día' },
  EXPIRING: { tone: 'warn', label: 'Documento por vencer' },
  EXPIRED: { tone: 'bad', label: 'Documento vencido' },
  NONE: { tone: 'none', label: 'Sin documentos' },
};
const DOC_STATUS: Record<VehicleDocument['status'], { tone: ChipTone; label: string }> = {
  VALID: { tone: 'ok', label: 'Vigente' },
  EXPIRING: { tone: 'warn', label: 'Por vencer' },
  EXPIRED: { tone: 'bad', label: 'Vencido' },
  NO_EXPIRY: { tone: 'none', label: 'Sin vencimiento' },
};
const FILE_NAME: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
};

function capacityText(v: Vehicle): string {
  const c = v.nominalCapacity;
  const parts = [
    c.passengers !== null && `${c.passengers} pasajeros`,
    c.weightKg !== null &&
      (c.weightKg >= 1000 ? `${fmtNumber(c.weightKg / 1000)} t` : `${fmtNumber(c.weightKg)} kg`),
    c.volumeM3 !== null && `${fmtNumber(c.volumeM3)} m³`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

function expiryText(d: VehicleDocument): string {
  if (!d.expiresOn) return 'Sin vencimiento';
  const n = daysUntil(d.expiresOn);
  if (n < 0) return `Venció el ${fmtDate(d.expiresOn)}`;
  if (n === 0) return `Vence hoy, ${fmtDate(d.expiresOn)}`;
  return `Vence el ${fmtDate(d.expiresOn)} (en ${n} ${n === 1 ? 'día' : 'días'})`;
}

/** El documento vigente de cada tipo: el que vence más tarde (sin vencimiento gana), como documentsSummary. */
function splitCurrent(docs: VehicleDocument[]): { current: VehicleDocument[]; history: VehicleDocument[] } {
  const best = new Map<string, VehicleDocument>();
  for (const d of docs.filter((x) => !x.archived)) {
    const seen = best.get(d.typeCode);
    if (!seen || (seen.expiresOn !== null && (d.expiresOn === null || d.expiresOn > seen.expiresOn))) {
      best.set(d.typeCode, d);
    }
  }
  const current = [...best.values()];
  return { current, history: docs.filter((d) => !current.includes(d)) };
}

type Data = { types: VehicleTypesResponse; vehicles: Vehicle[]; layouts: Layout[] | null };

/** Flota (Fase 6.4b; API de la 6.2 y la 6.3): vehículos, documentos con avisos que nunca bloquean y su plano. */
export function FleetView({ canLayouts }: { canLayouts: boolean }) {
  const { data, error, reload } = useLoad<Data>(async () => {
    const [types, vehicles, layouts] = await Promise.all([
      fleetApi.types(),
      fleetApi.vehicles(),
      canLayouts ? layoutsApi.list().then((r) => r.layouts) : Promise.resolve(null),
    ]);
    return { types, vehicles: vehicles.vehicles, layouts };
  });
  const [selected, setSelected] = useState<string | null>(null);
  // `?vehiculo=` (al volver de una inspección): abre esa unidad.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('vehiculo');
    if (id) setSelected(id);
  }, []);
  const [dialog, setDialog] = useState<'types' | 'vehicle-new' | 'vehicle-edit' | null>(null);
  const [status, setStatus] = useState('');

  const vehicles = data?.vehicles ?? [];
  const sel = vehicles.find((v) => v.id === selected) ?? vehicles[0] ?? null;
  const expired = vehicles.filter((v) => v.documents === 'EXPIRED').length;
  const expiring = vehicles.filter((v) => v.documents === 'EXPIRING').length;
  const activeTypes = data?.types.types.filter((t) => !t.archived) ?? [];

  const subtitle = !data
    ? 'Vehículos, sus documentos y su plano.'
    : [
        `${vehicles.length} ${vehicles.length === 1 ? 'vehículo' : 'vehículos'}`,
        expired > 0 && `${expired} con documentos vencidos`,
        expiring > 0 && `${expiring} por vencer`,
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <>
      <PageHeader
        title="Flota"
        subtitle={subtitle}
        actions={
          <>
            <button type="button" className={SECONDARY} disabled={!data} onClick={() => setDialog('types')}>
              Tipos de vehículo
            </button>
            <button
              type="button"
              className={PRIMARY}
              disabled={!data || activeTypes.length === 0}
              onClick={() => setDialog('vehicle-new')}
            >
              Nuevo vehículo
            </button>
          </>
        }
      />
      <LiveStatus message={status} />
      <div className={PAGE_BODY}>
        {error && <Alert>{error}</Alert>}
        {!data ? (
          !error && <Loading what="la flota" />
        ) : vehicles.length === 0 ? (
          <Empty>
            {activeTypes.length === 0
              ? 'Para registrar un vehículo, primero crea su tipo (bus, lancha, deslizador…) en «Tipos de vehículo».'
              : 'Aún no hay vehículos. Registra el primero con «Nuevo vehículo».'}
          </Empty>
        ) : (
          <div className="flex flex-wrap items-start gap-5">
            <section
              aria-labelledby="h-list"
              className="flex min-w-0 flex-[1_1_22rem] flex-col rounded-xl border border-divider bg-raised lg:max-w-[28rem]"
            >
              <h2 id="h-list" className={`${CARD_TITLE} px-5 pt-4 pb-2`}>
                Vehículos
              </h2>
              <ul>
                {vehicles.map((v) => {
                  const on = v.id === sel?.id;
                  return (
                    <li key={v.id} className="border-t border-divider">
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => setSelected(v.id)}
                        className={`flex min-h-16 w-full items-center justify-between gap-3 px-5 py-2.5 text-left ${
                          on ? 'bg-action/10 shadow-[inset_0_0_0_2px_var(--text-primary)]' : 'hover:bg-ink/5'
                        }`}
                      >
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[0.9375rem] font-bold">
                            {v.code} · {v.name}
                          </span>
                          <span className="text-[0.8125rem] text-ink-muted">
                            {v.vehicleTypeName} · {v.registration} · {STATUS_NAME[v.status]}
                          </span>
                        </span>
                        <Chip tone={SUMMARY[v.documents].tone}>{SUMMARY[v.documents].label}</Chip>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
            {sel && (
              <VehicleDetail
                key={sel.id}
                vehicle={sel}
                layouts={data.layouts}
                onEdit={() => setDialog('vehicle-edit')}
                onChanged={async (msg) => {
                  await reload();
                  setStatus(msg);
                }}
              />
            )}
          </div>
        )}
      </div>

      {data && dialog === 'types' && (
        <TypesDialog
          types={data.types}
          onClose={() => setDialog(null)}
          onChanged={async (msg) => {
            await reload();
            setStatus(msg);
          }}
        />
      )}
      {data && (dialog === 'vehicle-new' || (dialog === 'vehicle-edit' && sel)) && (
        <VehicleDialog
          item={dialog === 'vehicle-edit' ? sel : null}
          types={data.types.types.filter((t) => !t.archived || t.id === sel?.vehicleTypeId)}
          onClose={() => setDialog(null)}
          onSaved={async (v) => {
            setDialog(null);
            await reload();
            setSelected(v.id);
            setStatus(`Vehículo ${v.code} guardado`);
          }}
        />
      )}
    </>
  );
}

function VehicleDetail({
  vehicle: v,
  layouts,
  onEdit,
  onChanged,
}: {
  vehicle: Vehicle;
  layouts: Layout[] | null;
  onEdit: () => void;
  onChanged: (msg: string) => Promise<void>;
}) {
  const docs = useLoad<VehicleDocumentsResponse>(() => fleetApi.documents(v.id));
  const { can } = usePanel();
  const assignments = useLoad<LayoutAssignment[] | null>(() =>
    layouts ? fleetApi.assignments(v.id).then((r) => r.assignments) : Promise.resolve(null),
  );
  const [docDialog, setDocDialog] = useState<{ renew: VehicleDocument | null } | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const split = docs.data ? splitCurrent(docs.data.documents) : null;
  const worst =
    split?.current.find((d) => d.status === 'EXPIRED') ?? split?.current.find((d) => d.status === 'EXPIRING');

  const after = async (msg: string) => {
    await Promise.all([docs.reload(), assignments.reload()]);
    await onChanged(msg);
  };

  return (
    <section aria-labelledby="h-veh" className="flex min-w-0 flex-[999_1_30rem] flex-col gap-4">
      <div className={CARD}>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex flex-col gap-1">
            <h2 id="h-veh" className="font-display text-xl font-extrabold">
              {v.code} · {v.name}
            </h2>
            <p className="text-sm text-ink-muted">
              {v.vehicleTypeName} ({MODALITY_NAME[v.modality].toLowerCase()}) · placa o matrícula{' '}
              {v.registration} · {v.ownership === 'OWN' ? 'Propio' : 'De terceros'}
            </p>
          </div>
          <button type="button" className={SECONDARY} onClick={onEdit}>
            Editar
          </button>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <dt className="text-ink-muted">Estado</dt>
            <dd className="font-semibold">{STATUS_NAME[v.status]}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-ink-muted">Capacidad nominal</dt>
            <dd className="font-semibold">{capacityText(v)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-ink-muted">Características</dt>
            <dd className="font-semibold">{v.features.length ? v.features.join(', ') : '—'}</dd>
          </div>
        </dl>
      </div>

      {worst && (
        <div
          role="note"
          className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-xl px-4 py-3.5 ${
            worst.status === 'EXPIRED' ? 'bg-danger-surface' : 'bg-warning-surface'
          }`}
        >
          <p className="text-[0.9375rem] leading-[1.375rem]">
            <strong className={worst.status === 'EXPIRED' ? 'text-danger' : 'text-warning'}>
              {worst.typeName}: {expiryText(worst).toLowerCase()}.
            </strong>{' '}
            YEBO no bloquea el vehículo: renuévalo y sube el documento cuanto antes.
          </p>
          <button type="button" className={SECONDARY} onClick={() => setDocDialog({ renew: worst })}>
            Renovar {worst.typeName.toLowerCase()}
          </button>
        </div>
      )}

      <div className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className={CARD_TITLE}>Documentos</h3>
          <button
            type="button"
            className={SECONDARY}
            disabled={!docs.data}
            onClick={() => setDocDialog({ renew: null })}
          >
            Añadir documento
          </button>
        </div>
        {actionError && <Alert>{actionError}</Alert>}
        {docs.error && <Alert>{docs.error}</Alert>}
        {!split ? (
          !docs.error && <Loading what="los documentos" />
        ) : split.current.length === 0 ? (
          <Empty>
            Sin documentos. Añade los de este vehículo (por ejemplo, su certificado de matrícula o su SOAT)
            para que la flota te avise antes de que venzan.
          </Empty>
        ) : (
          <ul>
            {split.current.map((d) => (
              <DocumentRow key={d.id} vehicleId={v.id} doc={d} onRenew={() => setDocDialog({ renew: d })} />
            ))}
          </ul>
        )}
        {split && split.history.length > 0 && (
          <details className="text-sm">
            <summary className="min-h-11 cursor-pointer content-center font-semibold">
              Historial ({split.history.length})
            </summary>
            <ul>
              {split.history.map((d) => (
                <DocumentRow key={d.id} vehicleId={v.id} doc={d} history />
              ))}
            </ul>
          </details>
        )}
        <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
          Renovar crea un documento nuevo; el anterior queda en el historial. Los archivos (PDF, JPEG o PNG,
          hasta 10 MB) son privados: solo se descargan con tu sesión.
        </p>
      </div>

      {layouts && (
        <div className={CARD}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className={CARD_TITLE}>Plano</h3>
            <button
              type="button"
              className={SECONDARY}
              disabled={!assignments.data || v.status === 'RETIRED'}
              onClick={() => setAssigning(true)}
            >
              Asignar un plano…
            </button>
          </div>
          {assignments.error && <Alert>{assignments.error}</Alert>}
          {!assignments.data ? (
            !assignments.error && <Loading what="los planos asignados" />
          ) : assignments.data.length === 0 ? (
            <Empty>Sin plano asignado: asigna uno para poder programar este vehículo en viajes.</Empty>
          ) : (
            <ol>
              {assignments.data.map((a) => {
                const t = today();
                const state: { tone: ChipTone; label: string } =
                  a.validTo !== null && a.validTo <= t
                    ? { tone: 'none', label: 'Terminado' }
                    : a.validFrom > t
                      ? { tone: 'warn', label: 'Programado' }
                      : { tone: 'ok', label: 'Vigente' };
                return (
                  <li
                    key={a.id}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-divider py-2.5"
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="text-[0.9375rem] font-semibold">
                        {a.layoutName} · versión {a.version}
                      </span>
                      <span className="text-[0.8125rem] text-ink-muted">
                        Desde el {fmtDate(a.validFrom)}
                        {a.validTo ? `, hasta el ${fmtDate(a.validTo)} (sin incluir)` : ', sin fecha de fin'}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Chip tone={state.tone}>{state.label}</Chip>
                      {a.validTo === null && (
                        <button
                          type="button"
                          className={ROW_ACTION}
                          aria-label={`Terminar hoy la asignación de ${a.layoutName}`}
                          onClick={() => {
                            setActionError(null);
                            fleetApi
                              .endAssignment(v.id, a.id, a.validFrom > t ? a.validFrom : t)
                              .then(() => after(`${a.layoutName} terminado`))
                              .catch((e: unknown) => setActionError(errorMessage(e)));
                          }}
                        >
                          Terminar hoy
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
            Solo se asignan versiones publicadas de un plano de la misma modalidad. Los planos se crean en{' '}
            <Link href="/panel/planos" className={LINK}>
              Planos
            </Link>
            .
          </p>
        </div>
      )}

      {can('inspections.read') && <VehicleEquipmentSection vehicle={v} onStatus={(m) => void onChanged(m)} />}

      {docDialog && docs.data && (
        <DocumentDialog
          vehicle={v}
          types={docs.data.types}
          renew={docDialog.renew}
          onClose={() => setDocDialog(null)}
          onSaved={async (d) => {
            setDocDialog(null);
            await after(`Documento ${d.typeName} ${d.number} guardado`);
          }}
        />
      )}
      {assigning && layouts && (
        <AssignDialog
          vehicle={v}
          layouts={layouts}
          onClose={() => setAssigning(false)}
          onSaved={async (a) => {
            setAssigning(false);
            await after(`Plano ${a.layoutName} asignado`);
          }}
        />
      )}
    </section>
  );
}

function DocumentRow({
  vehicleId,
  doc: d,
  onRenew,
  history = false,
}: {
  vehicleId: string;
  doc: VehicleDocument;
  onRenew?: () => void;
  history?: boolean;
}) {
  const st = d.archived
    ? { tone: 'none' as const, label: 'Archivado' }
    : history
      ? { tone: 'none' as const, label: 'Reemplazado' }
      : DOC_STATUS[d.status];
  const file = d.file ? FILE_NAME[d.file.mime] : null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-divider py-3">
      <span className="flex flex-col gap-0.5">
        <span className="text-[0.9375rem] font-semibold">
          {d.typeName} · {d.number}
        </span>
        <span className="text-[0.8125rem] text-ink-muted">{expiryText(d)}</span>
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Chip tone={st.tone}>{st.label}</Chip>
        {file && (
          <a
            href={fleetApi.documentFileUrl(vehicleId, d.id)}
            className="inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4"
            aria-label={`Descargar ${d.typeName} ${d.number} (${file})`}
          >
            Descargar {file}
          </a>
        )}
        {onRenew && (d.status === 'EXPIRED' || d.status === 'EXPIRING') && (
          <button type="button" className={SECONDARY} onClick={onRenew}>
            Renovar
          </button>
        )}
      </span>
    </li>
  );
}

function useSubmit<T>(onSaved: (v: T) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (run: () => Promise<T>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSaved(await run());
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return { busy, error, setError, submit };
}

function Actions({ busy, label, onCancel }: { busy: boolean; label: string; onCancel: () => void }) {
  return (
    <div className="flex flex-wrap justify-end gap-3">
      <button type="button" className={SECONDARY} onClick={onCancel}>
        Cancelar
      </button>
      <button type="submit" className={PRIMARY} disabled={busy} aria-busy={busy || undefined}>
        {busy ? 'Guardando…' : label}
      </button>
    </div>
  );
}

const optNum = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));

function VehicleDialog({
  item,
  types,
  onClose,
  onSaved,
}: {
  item: Vehicle | null;
  types: VehicleType[];
  onClose: () => void;
  onSaved: (v: Vehicle) => Promise<void>;
}) {
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [typeId, setTypeId] = useState(item?.vehicleTypeId ?? types[0]?.id ?? '');
  const [registration, setRegistration] = useState(item?.registration ?? '');
  const [status, setStatus] = useState<VehicleStatus>(item?.status ?? 'ACTIVE');
  const [ownership, setOwnership] = useState(item?.ownership ?? 'OWN');
  const [passengers, setPassengers] = useState(item?.nominalCapacity.passengers?.toString() ?? '');
  const [weight, setWeight] = useState(item?.nominalCapacity.weightKg?.toString() ?? '');
  const [volume, setVolume] = useState(item?.nominalCapacity.volumeM3?.toString() ?? '');
  const [features, setFeatures] = useState(item?.features.join(', ') ?? '');
  const { busy, error, submit } = useSubmit(onSaved);
  const fields = () => ({
    name,
    vehicleTypeId: typeId,
    registration,
    status,
    ownership,
    nominalCapacity: { passengers: optNum(passengers), weightKg: optNum(weight), volumeM3: optNum(volume) },
    features: features
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean),
  });
  return (
    <Dialog
      title={item ? `Editar ${item.code}` : 'Nuevo vehículo'}
      description={item ? `Código ${item.code} (no cambia).` : undefined}
      onRequestClose={onClose}
      wide
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={submit(() =>
          item ? fleetApi.updateVehicle(item.id, fields()) : fleetApi.createVehicle({ code, ...fields() }),
        )}
      >
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          {!item && (
            <Input
              label="Código"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              required
              maxLength={16}
              hint="Por ejemplo, LANCHA-01. No cambia después."
            />
          )}
          <Input
            label="Nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={80}
          />
          <Select label="Tipo" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({MODALITY_NAME[t.modality].toLowerCase()})
              </option>
            ))}
          </Select>
          <Input
            label="Placa o matrícula"
            value={registration}
            onChange={(e) => setRegistration(e.target.value.toUpperCase())}
            required
          />
          <Select label="Estado" value={status} onChange={(e) => setStatus(e.target.value as VehicleStatus)}>
            {VEHICLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_NAME[s]}
              </option>
            ))}
          </Select>
          <Select label="Propiedad" value={ownership} onChange={(e) => setOwnership(e.target.value as 'OWN')}>
            <option value="OWN">Propio</option>
            <option value="THIRD_PARTY">De terceros</option>
          </Select>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">
            Capacidad nominal (la de la tarjeta o el certificado)
          </legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Pasajeros"
              value={passengers}
              onChange={(e) => setPassengers(e.target.value)}
              inputMode="numeric"
            />
            <Input
              label="Carga (kg)"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              inputMode="decimal"
            />
            <Input
              label="Volumen (m³)"
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <p className="text-[0.8125rem] text-ink-muted">Lo que se vende en cada viaje lo define su plano.</p>
        </fieldset>
        <Input
          label="Características (opcional)"
          value={features}
          onChange={(e) => setFeatures(e.target.value)}
          hint="Separadas por comas: aire acondicionado, baño, camarotes…"
        />
        <Actions busy={busy} label={item ? 'Guardar cambios' : 'Crear vehículo'} onCancel={onClose} />
      </form>
    </Dialog>
  );
}

function TypesDialog({
  types,
  onClose,
  onChanged,
}: {
  types: VehicleTypesResponse;
  onClose: () => void;
  onChanged: (msg: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [modality, setModality] = useState<Modality>('RIVER');
  const [catalogCode, setCatalogCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged(msg);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const suggestions = types.catalog.filter((c) => c.modality === modality);
  return (
    <Dialog
      title="Tipos de vehículo"
      description="Los tipos agrupan la flota (bus, lancha, deslizador…). Un tipo no se archiva mientras tenga vehículos."
      onRequestClose={onClose}
      wide
    >
      {error && <Alert>{error}</Alert>}
      {types.types.length === 0 ? (
        <Empty>Aún no hay tipos. Crea el primero abajo.</Empty>
      ) : (
        <ul>
          {types.types.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-divider py-2"
            >
              <span className="flex flex-col">
                <span className="font-semibold">{t.name}</span>
                <span className="text-[0.8125rem] text-ink-muted">
                  {MODALITY_NAME[t.modality]} · {t.activeVehicles}{' '}
                  {t.activeVehicles === 1 ? 'vehículo' : 'vehículos'}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {t.archived && <Chip tone="none">Archivado</Chip>}
                {(t.archived || t.activeVehicles === 0) && (
                  <button
                    type="button"
                    className={ROW_ACTION}
                    disabled={busy}
                    aria-label={`${t.archived ? 'Restaurar' : 'Archivar'} ${t.name}`}
                    onClick={() =>
                      void run(
                        () => (t.archived ? fleetApi.restoreType(t.id) : fleetApi.archiveType(t.id)),
                        `${t.name} ${t.archived ? 'restaurado' : 'archivado'}`,
                      )
                    }
                  >
                    {t.archived ? 'Restaurar' : 'Archivar'}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-4 border-t border-divider pt-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await run(
            () => fleetApi.createType({ name, modality, catalogCode: catalogCode || null }),
            `Tipo ${name} creado`,
          );
          if (ok) {
            setName('');
            setCatalogCode('');
          }
        }}
      >
        <h3 className="font-semibold">Nuevo tipo</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Select
            label="Modalidad"
            value={modality}
            onChange={(e) => {
              setModality(e.target.value as Modality);
              setCatalogCode('');
            }}
          >
            <option value="RIVER">Fluvial</option>
            <option value="LAND">Terrestre</option>
          </Select>
          <Select
            label="Sugerencia (opcional)"
            value={catalogCode}
            onChange={(e) => {
              setCatalogCode(e.target.value);
              const s = suggestions.find((c) => c.code === e.target.value);
              if (s && !name) setName(s.name);
            }}
          >
            <option value="">Ninguna</option>
            {suggestions.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
          <Input
            label="Nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={60}
          />
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cerrar
          </button>
          <button type="submit" className={PRIMARY} disabled={busy}>
            Crear tipo
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DocumentDialog({
  vehicle,
  types,
  renew,
  onClose,
  onSaved,
}: {
  vehicle: Vehicle;
  types: VehicleDocumentsResponse['types'];
  renew: VehicleDocument | null;
  onClose: () => void;
  onSaved: (d: VehicleDocument) => Promise<void>;
}) {
  const [typeCode, setTypeCode] = useState(renew?.typeCode ?? types[0]?.code ?? '');
  const [number, setNumber] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, submit } = useSubmit(onSaved);
  return (
    <Dialog
      title={renew ? `Renovar ${renew.typeName.toLowerCase()}` : 'Añadir documento'}
      description={`${vehicle.code} · ${vehicle.name}. ${renew ? 'El documento anterior queda en el historial.' : ''}`}
      onRequestClose={onClose}
      wide
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={submit(async () => {
          const uploaded = file ? await uploadDocumentFile(file) : null;
          return fleetApi.createDocument(vehicle.id, {
            typeCode,
            number,
            issuedOn: issuedOn || null,
            expiresOn: expiresOn || null,
            fileAssetId: uploaded?.id ?? null,
          });
        })}
      >
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Tipo de documento"
            value={typeCode}
            onChange={(e) => setTypeCode(e.target.value)}
            disabled={!!renew}
          >
            {types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </Select>
          <Input
            label="Número"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            required
            maxLength={40}
          />
          <Input
            label="Emisión (opcional)"
            type="date"
            value={issuedOn}
            onChange={(e) => setIssuedOn(e.target.value)}
          />
          <Input
            label="Vencimiento"
            type="date"
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
            hint="Déjalo vacío si no vence"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="doc-file" className="text-sm font-medium">
            Archivo (opcional)
          </label>
          <input
            id="doc-file"
            type="file"
            accept={DOCUMENT_FILE_TYPES.join(',')}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            aria-describedby="doc-file-hint"
            className="min-h-11 text-sm file:mr-3 file:min-h-11 file:rounded-[var(--radius-control)] file:border file:border-control-strong file:bg-raised file:px-4 file:font-semibold"
          />
          <span id="doc-file-hint" className="text-[0.8125rem] text-ink-muted">
            PDF, JPEG o PNG, hasta 10 MB. Es privado: solo se descarga con sesión.
          </span>
        </div>
        <Actions busy={busy} label={renew ? 'Guardar renovación' : 'Añadir documento'} onCancel={onClose} />
      </form>
    </Dialog>
  );
}

function AssignDialog({
  vehicle,
  layouts,
  onClose,
  onSaved,
}: {
  vehicle: Vehicle;
  layouts: Layout[];
  onClose: () => void;
  onSaved: (a: LayoutAssignment) => Promise<void>;
}) {
  const options = layouts
    .filter((l) => !l.archived && l.modality === vehicle.modality)
    .filter((l) => l.vehicleTypeId === null || l.vehicleTypeId === vehicle.vehicleTypeId)
    .flatMap((l) =>
      l.versions
        .filter((v) => v.status === 'PUBLISHED')
        .map((v) => ({ key: `${l.id}:${v.version}`, layout: l, version: v.version })),
    );
  const [choice, setChoice] = useState(options[0]?.key ?? '');
  const [validFrom, setValidFrom] = useState(today());
  const [validTo, setValidTo] = useState('');
  const { busy, error, submit } = useSubmit(onSaved);
  useEffect(() => {
    if (!choice && options[0]) setChoice(options[0].key);
  }, [choice, options]);
  const picked = options.find((o) => o.key === choice);
  return (
    <Dialog
      title="Asignar un plano"
      description={`${vehicle.code} · ${vehicle.name}`}
      onRequestClose={onClose}
    >
      {options.length === 0 ? (
        <>
          <Empty>
            No hay versiones publicadas de planos {vehicle.modality === 'RIVER' ? 'fluviales' : 'terrestres'}{' '}
            para este tipo de vehículo. Crea y publica uno en{' '}
            <Link href="/panel/planos" className={LINK}>
              Planos
            </Link>
            .
          </Empty>
          <div className="flex justify-end">
            <button type="button" className={SECONDARY} onClick={onClose}>
              Cerrar
            </button>
          </div>
        </>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={submit(() =>
            fleetApi.assign(vehicle.id, {
              layoutId: picked!.layout.id,
              version: picked!.version,
              validFrom,
              validTo: validTo || null,
            }),
          )}
        >
          {error && <Alert>{error}</Alert>}
          <Select label="Plano y versión" value={choice} onChange={(e) => setChoice(e.target.value)}>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.layout.name} · versión {o.version}
              </option>
            ))}
          </Select>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Desde"
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              required
            />
            <Input
              label="Hasta (opcional)"
              type="date"
              value={validTo}
              onChange={(e) => setValidTo(e.target.value)}
              hint="Sin incluir ese día. Vacío: sin fecha de fin."
            />
          </div>
          <Actions busy={busy} label="Asignar" onCancel={onClose} />
        </form>
      )}
    </Dialog>
  );
}
