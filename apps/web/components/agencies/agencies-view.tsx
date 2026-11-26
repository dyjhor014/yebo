'use client';

import { isValidRuc, type Agency } from '@yebo/contracts';
import { Dialog } from '@yebo/ui/dialog';
import { Alert, Input, PRIMARY, ScrollRegion } from '@yebo/ui/form';
import Link from 'next/link';
import { useState } from 'react';
import {
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
import { agenciesApi } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';

const TH = 'px-4 py-3 text-left text-[0.8125rem] font-semibold text-ink-muted';
const TD = 'px-4 py-3.5 align-top text-sm';

const loadAgencies = async () => (await agenciesApi.list()).agencies;

/**
 * Agencias externas (Fase 6.5b; API de la 6.5a, F6-Q2): registro mínimo con su canal de venta. Las comisiones y los
 * usuarios de agencia llegan con la venta (Fase 8) y la liquidación (Fase 11).
 */
export function AgenciesView() {
  const { data, error, reload } = useLoad(loadAgencies);
  const [editing, setEditing] = useState<{ item: Agency | null } | null>(null);
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const toggleArchive = async (a: Agency) => {
    setBusy(a.id);
    setActionError(null);
    try {
      await (a.archived ? agenciesApi.restore(a.id) : agenciesApi.archive(a.id));
      await reload();
      setStatus(
        `${a.name} ${a.archived ? 'restaurada; su canal vuelve a estar activo' : 'archivada; su canal queda inactivo'}`,
      );
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Agencias"
        subtitle="Agencias externas que venden por la empresa, cada una con su canal de venta."
        actions={
          <button
            type="button"
            className={PRIMARY}
            disabled={!data}
            onClick={() => setEditing({ item: null })}
          >
            Nueva agencia
          </button>
        }
      />
      <div className={PAGE_BODY}>
        <LiveStatus message={status} />
        {actionError && <Alert>{actionError}</Alert>}
        {error && <Alert>{error}</Alert>}
        {!data ? (
          !error && <Loading what="las agencias" />
        ) : data.length === 0 ? (
          <Empty>
            Aún no hay agencias. Registra la primera con su RUC: nace con su canal de venta, listo para cuando
            vendan pasajes y encomiendas.
          </Empty>
        ) : (
          <ScrollRegion label="Agencias">
            <table className="w-full min-w-[52rem] border-collapse rounded-xl border border-divider bg-raised">
              <thead>
                <tr>
                  <th scope="col" className={TH}>
                    Agencia
                  </th>
                  <th scope="col" className={TH}>
                    Contacto
                  </th>
                  <th scope="col" className={TH}>
                    Canal de venta
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
                {data.map((a) => {
                  const contact = [a.contactPhone, a.contactEmail].filter(Boolean).join(' · ');
                  return (
                    <tr key={a.id} className="border-t border-divider">
                      <td className={TD}>
                        <span className="flex flex-col gap-0.5">
                          <span className="text-[0.9375rem] font-semibold">{a.name}</span>
                          <span className="text-[0.8125rem] text-ink-muted">RUC {a.taxId}</span>
                        </span>
                      </td>
                      <td className={TD}>
                        {a.contactName || contact ? (
                          <span className="flex flex-col gap-0.5">
                            {a.contactName && <span>{a.contactName}</span>}
                            {contact && <span className="text-[0.8125rem] text-ink-muted">{contact}</span>}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={TD}>
                        <span className="flex flex-col items-start gap-1">
                          <span>{a.channel.code}</span>
                          <Chip tone={a.channel.isActive ? 'ok' : 'none'}>
                            {a.channel.isActive ? 'Activo' : 'Inactivo'}
                          </Chip>
                        </span>
                      </td>
                      <td className={TD}>
                        <Chip tone={a.archived ? 'none' : 'ok'}>{a.archived ? 'Archivada' : 'Activa'}</Chip>
                      </td>
                      <td className={`${TD} text-right whitespace-nowrap`}>
                        {!a.archived && (
                          <button
                            type="button"
                            className={ROW_ACTION}
                            aria-label={`Editar ${a.name}`}
                            onClick={() => setEditing({ item: a })}
                          >
                            Editar
                          </button>
                        )}
                        <button
                          type="button"
                          className={ROW_ACTION}
                          disabled={busy === a.id}
                          aria-label={`${a.archived ? 'Restaurar' : 'Archivar'} ${a.name}`}
                          onClick={() => void toggleArchive(a)}
                        >
                          {a.archived ? 'Restaurar' : 'Archivar'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollRegion>
        )}
        <p className="text-sm leading-5 text-ink-muted">
          Al archivar una agencia su canal se desactiva, y vuelve a estar activo al restaurarla. El RUC no
          cambia después del alta. Para renombrar o pausar un canal, ve a{' '}
          <Link href="/panel/ubicaciones" className="font-semibold text-ink underline underline-offset-4">
            Ubicaciones › Canales de venta
          </Link>
          . Las comisiones llegarán con la venta.
        </p>
      </div>

      {editing && (
        <AgencyDialog
          item={editing.item}
          onClose={() => setEditing(null)}
          onSaved={async (name) => {
            setEditing(null);
            await reload();
            setStatus(`Agencia ${name} guardada`);
          }}
        />
      )}
    </>
  );
}

function AgencyDialog({
  item,
  onClose,
  onSaved,
}: {
  item: Agency | null;
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
}) {
  const [taxId, setTaxId] = useState('');
  const [rucError, setRucError] = useState<string | undefined>();
  const [name, setName] = useState(item?.name ?? '');
  const [contactName, setContactName] = useState(item?.contactName ?? '');
  const [contactPhone, setContactPhone] = useState(item?.contactPhone ?? '');
  const [contactEmail, setContactEmail] = useState(item?.contactEmail ?? '');
  const { busy, error, submit } = useSubmit(onSaved);
  // Vacío = sin dato (el contrato lo convierte en null).
  const fields = () => ({ name, contactName, contactPhone, contactEmail });
  const save = submit(() =>
    item ? agenciesApi.update(item.id, fields()) : agenciesApi.create({ taxId, ...fields() }),
  );
  return (
    <Dialog
      title={item ? `Editar ${item.name}` : 'Nueva agencia'}
      description={
        item ? `RUC ${item.taxId} (no cambia).` : 'Nace con su canal de venta. El RUC no cambia después.'
      }
      onRequestClose={onClose}
      wide
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          // El dígito verificador se comprueba antes de enviar, junto al campo.
          if (!item && !isValidRuc(taxId.trim())) {
            e.preventDefault();
            setRucError(
              'Revisa el RUC: 11 dígitos que empiezan por 10, 15, 17 o 20, con su dígito verificador.',
            );
            (e.currentTarget.elements.namedItem('ruc') as HTMLInputElement | null)?.focus();
            return;
          }
          setRucError(undefined);
          void save(e);
        }}
      >
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          {!item && (
            <Input
              label="RUC"
              name="ruc"
              value={taxId}
              // Se pega con espacios o guiones: quedan los dígitos, hasta 11.
              onChange={(e) => setTaxId(e.target.value.replace(/\D/g, '').slice(0, 11))}
              required
              inputMode="numeric"
              autoComplete="off"
              error={rucError}
              hint="11 dígitos."
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
        </div>
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-medium">Contacto (opcional)</legend>
          <Input
            label="Persona de contacto"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            maxLength={80}
            autoComplete="off"
          />
          <Input
            label="Teléfono"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            inputMode="tel"
            maxLength={20}
            autoComplete="off"
          />
          <Input
            label="Correo"
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            maxLength={254}
            autoComplete="off"
          />
        </fieldset>
        <DialogActions busy={busy} label={item ? 'Guardar cambios' : 'Crear agencia'} onCancel={onClose} />
      </form>
    </Dialog>
  );
}
