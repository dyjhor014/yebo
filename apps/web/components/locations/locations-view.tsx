'use client';

import {
  type Agency,
  type Branch,
  type Location,
  type LocationKind,
  type LocationsResponse,
  type SalesChannel,
  type SalesChannelKind,
} from '@yebo/contracts';
import { Dialog } from '@yebo/ui/dialog';
import { Alert, Input, PRIMARY, ScrollRegion, Select } from '@yebo/ui/form';
import { useEffect, useState } from 'react';
import {
  Check,
  Chip,
  DialogActions,
  Empty,
  LiveStatus,
  Loading,
  PAGE_BODY,
  PageHeader,
  ROW_ACTION,
  useLoad,
  useSubmit,
} from '@/components/panel/kit';
import { Tabs } from '@/components/site-editor/editor-fields';
import { usePanel } from '@/components/panel/panel-session';
import { agenciesApi, locationsApi } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';
import { loadUbigeo, ubigeoLabel, type UbigeoCatalog } from '@/lib/ubigeo';

type Tab = 'locations' | 'branches' | 'channels';
const TABS = [
  { id: 'locations', label: 'Ubicaciones' },
  { id: 'branches', label: 'Sucursales' },
  { id: 'channels', label: 'Canales de venta' },
] as const;

const CHANNEL_KIND: Record<SalesChannelKind, string> = {
  COUNTER: 'Mostrador',
  ONLINE: 'En línea',
  EXTERNAL_AGENCY: 'Agencia externa',
  CALL_CENTER: 'Central telefónica',
  API: 'Integración (API)',
};

const TH = 'px-4 py-3 text-left text-[0.8125rem] font-semibold text-ink-muted';
const TD = 'px-4 py-3.5 align-top text-sm';

type Data = {
  locations: LocationsResponse;
  branches: Branch[];
  channels: SalesChannel[];
  /** Solo con el módulo AGENCIES y el permiso: para nombrar la agencia de cada canal (Fase 6.5b). */
  agencies: Agency[] | null;
};

const loadAll = (withAgencies: boolean) => async (): Promise<Data> => {
  const [locations, branches, channels, agencies] = await Promise.all([
    locationsApi.list(),
    locationsApi.branches(),
    locationsApi.channels(),
    withAgencies ? agenciesApi.list() : null,
  ]);
  return {
    locations,
    branches: branches.branches,
    channels: channels.channels,
    agencies: agencies?.agencies ?? null,
  };
};

type Editing =
  | { kind: 'location'; item: Location | null }
  | { kind: 'branch'; item: Branch | null }
  | { kind: 'channel'; item: SalesChannel }
  | null;

/** Ubicaciones, sucursales y canales de venta (Fase 6.4b; API de la 6.1). */
export function LocationsView() {
  const { can, hasModule } = usePanel();
  const { data, error, reload } = useLoad(loadAll(hasModule('AGENCIES') && can('agencies.manage')));
  const [ubigeos, setUbigeos] = useState<UbigeoCatalog | null>(null);
  useEffect(() => {
    // Solo para mostrar el distrito en la tabla; si no carga, se muestra la región guardada.
    loadUbigeo().then(setUbigeos, () => {});
  }, []);
  const [tab, setTab] = useState<Tab>('locations');
  const [editing, setEditing] = useState<Editing>(null);
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  const newLabel = tab === 'locations' ? 'Nueva ubicación' : tab === 'branches' ? 'Nueva sucursal' : null;
  const activeLocations = data?.locations.locations.filter((l) => !l.archived) ?? [];
  const kindName = (k: LocationKind) => data?.locations.kinds.find((x) => x.code === k)?.name ?? k;

  return (
    <>
      <PageHeader
        title="Ubicaciones"
        subtitle="Puertos, embarcaderos y ciudades donde opera la empresa, sus sucursales y canales de venta."
        actions={
          newLabel && (
            <button
              type="button"
              className={PRIMARY}
              disabled={!data || (tab === 'branches' && activeLocations.length === 0)}
              onClick={() =>
                setEditing(
                  tab === 'locations' ? { kind: 'location', item: null } : { kind: 'branch', item: null },
                )
              }
            >
              {newLabel}
            </button>
          )
        }
      />
      <div className={PAGE_BODY}>
        <Tabs
          label="Ubicaciones, sucursales y canales"
          value={tab}
          tabs={TABS}
          errors={{}}
          onChange={setTab}
          idFor={(t) => `tab-${t}`}
        />
        <LiveStatus message={status} />
        {actionError && <Alert>{actionError}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div
          id={`tab-${tab}-panel`}
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          className="flex flex-col gap-3"
        >
          {!data ? (
            !error && <Loading what="las ubicaciones" />
          ) : tab === 'locations' ? (
            data.locations.locations.length === 0 ? (
              <Empty>
                Aún no hay ubicaciones. Crea la primera (un puerto, un embarcadero, una ciudad o un terminal)
                para abrir sucursales en ella.
              </Empty>
            ) : (
              <ScrollRegion label="Ubicaciones">
                <table className="w-full min-w-[46rem] border-collapse rounded-xl border border-divider bg-raised">
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>
                        Ubicación
                      </th>
                      <th scope="col" className={TH}>
                        Tipo
                      </th>
                      <th scope="col" className={TH}>
                        Ubigeo
                      </th>
                      <th scope="col" className={TH}>
                        Sucursales activas
                      </th>
                      <th scope="col" className={TH}>
                        Estado
                      </th>
                      <th scope="col" className={TH}>
                        <span className="sr-only">Acciones</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.locations.locations.map((l) => (
                      <tr key={l.id} className="border-t border-divider">
                        <td className={TD}>
                          <span className="flex flex-col gap-0.5">
                            <span className="text-[0.9375rem] font-semibold">{l.name}</span>
                            {(ubigeos && ubigeoLabel(ubigeos, l.ubigeo)) || l.region ? (
                              <span className="text-[0.8125rem] text-ink-muted">
                                {(ubigeos && ubigeoLabel(ubigeos, l.ubigeo)) ?? l.region}
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className={TD}>{kindName(l.kind)}</td>
                        <td className={TD}>{l.ubigeo ?? '—'}</td>
                        <td className={TD}>{l.activeBranches}</td>
                        <td className={TD}>
                          <Chip tone={l.archived ? 'none' : 'ok'}>{l.archived ? 'Archivada' : 'Activa'}</Chip>
                        </td>
                        <td className={`${TD} text-right whitespace-nowrap`}>
                          <button
                            type="button"
                            className={ROW_ACTION}
                            aria-label={`Editar ${l.name}`}
                            onClick={() => setEditing({ kind: 'location', item: l })}
                          >
                            Editar
                          </button>
                          {(l.archived || l.activeBranches === 0) && (
                            <button
                              type="button"
                              className={ROW_ACTION}
                              disabled={busy === l.id}
                              aria-label={`${l.archived ? 'Restaurar' : 'Archivar'} ${l.name}`}
                              onClick={() =>
                                void act(
                                  l.id,
                                  () =>
                                    l.archived ? locationsApi.restore(l.id) : locationsApi.archive(l.id),
                                  `${l.name} ${l.archived ? 'restaurada' : 'archivada'}`,
                                )
                              }
                            >
                              {l.archived ? 'Restaurar' : 'Archivar'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            )
          ) : tab === 'branches' ? (
            data.branches.length === 0 ? (
              <Empty>
                {activeLocations.length === 0
                  ? 'Para abrir una sucursal, primero crea su ubicación en la pestaña «Ubicaciones».'
                  : 'Aún no hay sucursales. Cada sucursal nace con su mostrador de venta.'}
              </Empty>
            ) : (
              <ScrollRegion label="Sucursales">
                <table className="w-full min-w-[50rem] border-collapse rounded-xl border border-divider bg-raised">
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>
                        Sucursal
                      </th>
                      <th scope="col" className={TH}>
                        Ubicación
                      </th>
                      <th scope="col" className={TH}>
                        Encomiendas
                      </th>
                      <th scope="col" className={TH}>
                        Estado
                      </th>
                      <th scope="col" className={TH}>
                        <span className="sr-only">Acciones</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.branches.map((b) => (
                      <tr key={b.id} className="border-t border-divider">
                        <td className={TD}>
                          <span className="flex flex-col gap-0.5">
                            <span className="text-[0.9375rem] font-semibold">
                              {b.code} · {b.name}
                            </span>
                            <span className="text-[0.8125rem] text-ink-muted">
                              {[b.address, ...b.phones].join(' · ')}
                            </span>
                          </span>
                        </td>
                        <td className={TD}>{b.locationName}</td>
                        <td className={TD}>
                          {b.isPickupPoint && b.isReceptionPoint
                            ? 'Recojo y recepción'
                            : b.isPickupPoint
                              ? 'Solo recojo'
                              : b.isReceptionPoint
                                ? 'Solo recepción'
                                : '—'}
                        </td>
                        <td className={TD}>
                          <Chip tone={b.archived ? 'none' : 'ok'}>{b.archived ? 'Archivada' : 'Activa'}</Chip>
                        </td>
                        <td className={`${TD} text-right whitespace-nowrap`}>
                          {!b.archived && (
                            <button
                              type="button"
                              className={ROW_ACTION}
                              aria-label={`Editar ${b.name}`}
                              onClick={() => setEditing({ kind: 'branch', item: b })}
                            >
                              Editar
                            </button>
                          )}
                          <button
                            type="button"
                            className={ROW_ACTION}
                            disabled={busy === b.id}
                            aria-label={`${b.archived ? 'Restaurar' : 'Archivar'} ${b.name}`}
                            onClick={() =>
                              void act(
                                b.id,
                                () =>
                                  b.archived
                                    ? locationsApi.restoreBranch(b.id)
                                    : locationsApi.archiveBranch(b.id),
                                `${b.name} ${b.archived ? 'restaurada' : 'archivada'}`,
                              )
                            }
                          >
                            {b.archived ? 'Restaurar' : 'Archivar'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            )
          ) : (
            <ScrollRegion label="Canales de venta">
              <table className="w-full min-w-[46rem] border-collapse rounded-xl border border-divider bg-raised">
                <thead>
                  <tr>
                    <th scope="col" className={TH}>
                      Canal
                    </th>
                    <th scope="col" className={TH}>
                      Clase
                    </th>
                    <th scope="col" className={TH}>
                      Sucursal o agencia
                    </th>
                    <th scope="col" className={TH}>
                      Estado
                    </th>
                    <th scope="col" className={TH}>
                      <span className="sr-only">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.channels.map((c) => {
                    const branch = data.branches.find((b) => b.id === c.branchId);
                    const agency = data.agencies?.find((a) => a.id === c.agencyId);
                    return (
                      <tr key={c.id} className="border-t border-divider">
                        <td className={TD}>
                          <span className="flex flex-col gap-0.5">
                            <span className="text-[0.9375rem] font-semibold">{c.name}</span>
                            <span className="text-[0.8125rem] text-ink-muted">Código {c.code}</span>
                          </span>
                        </td>
                        <td className={TD}>{CHANNEL_KIND[c.kind]}</td>
                        <td className={TD}>
                          {branch
                            ? `${branch.code}${branch.archived ? ' (archivada)' : ''}`
                            : agency
                              ? `${agency.name}${agency.archived ? ' (archivada)' : ''}`
                              : '—'}
                        </td>
                        <td className={TD}>
                          <Chip tone={c.isActive ? 'ok' : 'none'}>{c.isActive ? 'Activo' : 'Inactivo'}</Chip>
                        </td>
                        <td className={`${TD} text-right whitespace-nowrap`}>
                          <button
                            type="button"
                            className={ROW_ACTION}
                            aria-label={`Editar ${c.name}`}
                            onClick={() => setEditing({ kind: 'channel', item: c })}
                          >
                            Editar
                          </button>
                          {/* El canal de una sucursal o agencia archivada no se activa: se restaura ella. */}
                          {!branch?.archived && !agency?.archived && (
                            <button
                              type="button"
                              className={ROW_ACTION}
                              disabled={busy === c.id}
                              aria-label={`${c.isActive ? 'Desactivar' : 'Activar'} ${c.name}`}
                              onClick={() =>
                                void act(
                                  c.id,
                                  () =>
                                    locationsApi.updateChannel(c.id, { name: c.name, isActive: !c.isActive }),
                                  `${c.name} ${c.isActive ? 'desactivado' : 'activado'}`,
                                )
                              }
                            >
                              {c.isActive ? 'Desactivar' : 'Activar'}
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
            {tab === 'locations'
              ? 'Una ubicación no se archiva mientras tenga sucursales activas. El ubigeo del INEI es opcional y sirve para relacionarla con otras empresas más adelante.'
              : tab === 'branches'
                ? 'Cada sucursal nace con su mostrador de venta; al archivarla, el mostrador se desactiva. El código no cambia después de crearla.'
                : 'Los canales se renombran y se activan o desactivan. El de una agencia externa nace con ella, en «Agencias», y sigue a su agencia al archivarla.'}
          </p>
        </div>
      </div>

      {data && editing?.kind === 'location' && (
        <LocationDialog
          item={editing.item}
          kinds={data.locations.kinds}
          onClose={() => setEditing(null)}
          onSaved={async (name) => {
            setEditing(null);
            await reload();
            setStatus(`Ubicación ${name} guardada`);
          }}
        />
      )}
      {data && editing?.kind === 'branch' && (
        <BranchDialog
          item={editing.item}
          locations={data.locations.locations.filter((l) => !l.archived || l.id === editing.item?.locationId)}
          onClose={() => setEditing(null)}
          onSaved={async (name) => {
            setEditing(null);
            await reload();
            setStatus(`Sucursal ${name} guardada`);
          }}
        />
      )}
      {editing?.kind === 'channel' && (
        <ChannelDialog
          item={editing.item}
          onClose={() => setEditing(null)}
          onSaved={async (name) => {
            setEditing(null);
            await reload();
            setStatus(`Canal ${name} guardado`);
          }}
        />
      )}
    </>
  );
}

const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));

function LocationDialog({
  item,
  kinds,
  onClose,
  onSaved,
}: {
  item: Location | null;
  kinds: LocationsResponse['kinds'];
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [kind, setKind] = useState<LocationKind>(item?.kind ?? 'PORT');
  const [ubigeo, setUbigeo] = useState(item?.ubigeo ?? '');
  const [dep, setDep] = useState(item?.ubigeo?.slice(0, 2) ?? '');
  const [prov, setProv] = useState(item?.ubigeo?.slice(0, 4) ?? '');
  const [lat, setLat] = useState(item?.lat?.toString() ?? '');
  const [lng, setLng] = useState(item?.lng?.toString() ?? '');
  const [cat, setCat] = useState<UbigeoCatalog | null>(null);
  const [catError, setCatError] = useState<string | null>(null);
  const { busy, error, submit } = useSubmit(onSaved);
  useEffect(() => {
    loadUbigeo()
      .then(setCat)
      .catch((e: unknown) => setCatError(errorMessage(e)));
  }, []);

  const depName = cat?.departments.find((d) => d.code === dep)?.name ?? null;
  const provinces = cat?.provinces.filter((p) => p.code.startsWith(dep)) ?? [];
  const districts = cat?.districts.filter((d) => d.code.startsWith(prov)) ?? [];
  const district = ubigeo ? (cat?.byCode.get(ubigeo) ?? null) : null;

  const pickDistrict = (code: string) => {
    setUbigeo(code);
    const d = cat?.byCode.get(code);
    if (!d) return;
    // El nombre es libre (p. ej., «Puerto Pucallpa»): solo se propone si está vacío.
    if (!name.trim()) setName(d.name);
    if (d.lat !== null && d.lng !== null) {
      setLat(String(d.lat));
      setLng(String(d.lng));
    }
  };
  const input = () => ({
    name,
    kind,
    // Sin catálogo (no cargó), se conserva la región que ya tenía.
    region: depName ?? (cat ? null : (item?.region ?? null)),
    ubigeo: ubigeo || null,
    lat: num(lat),
    lng: num(lng),
  });
  return (
    <Dialog title={item ? `Editar ${item.name}` : 'Nueva ubicación'} onRequestClose={onClose} wide>
      <form
        className="flex flex-col gap-4"
        onSubmit={submit(() => (item ? locationsApi.update(item.id, input()) : locationsApi.create(input())))}
      >
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={80}
            hint="Como lo conocen tus clientes: Puerto Pucallpa, Embarcadero Masusa…"
          />
          <Select label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as LocationKind)}>
            {kinds.map((k) => (
              <option key={k.code} value={k.code}>
                {k.name}
              </option>
            ))}
          </Select>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Distrito (opcional)</legend>
          {catError ? (
            <Alert>{catError}. Puedes guardar la ubicación sin distrito y elegirlo después.</Alert>
          ) : !cat ? (
            <p role="status" className="text-sm text-ink-muted">
              Cargando departamentos, provincias y distritos…
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <Select
                label="Departamento"
                value={dep}
                onChange={(e) => {
                  setDep(e.target.value);
                  setProv('');
                  setUbigeo('');
                }}
              >
                <option value="">Elige…</option>
                {cat.departments.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </Select>
              <Select
                label="Provincia"
                value={prov}
                disabled={!dep}
                onChange={(e) => {
                  setProv(e.target.value);
                  setUbigeo('');
                }}
              >
                <option value="">{dep ? 'Elige…' : 'Primero el departamento'}</option>
                {provinces.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <Select
                label="Distrito"
                value={ubigeo}
                disabled={!prov}
                onChange={(e) => pickDistrict(e.target.value)}
              >
                <option value="">{prov ? 'Elige…' : 'Primero la provincia'}</option>
                {districts.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted" aria-live="polite">
            {district
              ? `Ubigeo del INEI: ${ubigeo}. Sirve para relacionar esta ubicación con la de otras empresas.`
              : 'Al elegir el distrito, YEBO completa su ubigeo del INEI y sus coordenadas.'}
          </p>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Latitud (opcional)"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            inputMode="decimal"
          />
          <Input
            label="Longitud (opcional)"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            inputMode="decimal"
            hint={district ? 'Las del distrito; ajústalas al punto exacto si quieres.' : undefined}
          />
        </div>
        <DialogActions busy={busy} label={item ? 'Guardar cambios' : 'Crear ubicación'} onCancel={onClose} />
      </form>
    </Dialog>
  );
}

function BranchDialog({
  item,
  locations,
  onClose,
  onSaved,
}: {
  item: Branch | null;
  locations: Location[];
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
}) {
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [locationId, setLocationId] = useState(item?.locationId ?? locations[0]?.id ?? '');
  const [address, setAddress] = useState(item?.address ?? '');
  const [phones, setPhones] = useState(item?.phones.join(', ') ?? '');
  const [pickup, setPickup] = useState(item?.isPickupPoint ?? true);
  const [reception, setReception] = useState(item?.isReceptionPoint ?? true);
  const { busy, error, submit } = useSubmit(onSaved);
  const fields = () => ({
    locationId,
    name,
    address,
    phones: phones
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    isPickupPoint: pickup,
    isReceptionPoint: reception,
  });
  return (
    <Dialog
      title={item ? `Editar ${item.name}` : 'Nueva sucursal'}
      description={item ? `Código ${item.code} (no cambia).` : 'Nace con su mostrador de venta.'}
      onRequestClose={onClose}
      wide
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={submit(() =>
          item
            ? locationsApi.updateBranch(item.id, fields())
            : locationsApi.createBranch({ code, ...fields() }),
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
              maxLength={12}
              hint="Por ejemplo, PCL-01. No cambia después."
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
          <Select label="Ubicación" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          <Input
            label="Dirección"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            required
            minLength={3}
            maxLength={200}
          />
          <Input
            label="Teléfonos (opcional)"
            value={phones}
            onChange={(e) => setPhones(e.target.value)}
            hint="Separados por comas, hasta 4"
            inputMode="tel"
          />
        </div>
        <fieldset className="flex flex-col">
          <legend className="mb-1 text-sm font-medium">Encomiendas</legend>
          <Check label="Recibe encomiendas para enviar" checked={reception} onChange={setReception} />
          <Check label="Entrega encomiendas al cliente (recojo)" checked={pickup} onChange={setPickup} />
        </fieldset>
        <DialogActions busy={busy} label={item ? 'Guardar cambios' : 'Crear sucursal'} onCancel={onClose} />
      </form>
    </Dialog>
  );
}

function ChannelDialog({
  item,
  onClose,
  onSaved,
}: {
  item: SalesChannel;
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(item.name);
  const { busy, error, submit } = useSubmit(onSaved);
  return (
    <Dialog title={`Editar ${item.name}`} description={`Código ${item.code}.`} onRequestClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={submit(() => locationsApi.updateChannel(item.id, { name, isActive: item.isActive }))}
      >
        {error && <Alert>{error}</Alert>}
        <Input
          label="Nombre"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          minLength={2}
          maxLength={80}
        />
        <DialogActions busy={busy} label="Guardar cambios" onCancel={onClose} />
      </form>
    </Dialog>
  );
}
