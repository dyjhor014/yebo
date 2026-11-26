'use client';

import {
  EQUIPMENT_LIMITS,
  suggestedResult,
  type InspectionDetail,
  type InspectionItem,
  type InspectionResult,
} from '@yebo/contracts';
import { Dialog } from '@yebo/ui/dialog';
import { Alert, DANGER_LINK, LINK, PRIMARY, SECONDARY, Textarea } from '@yebo/ui/form';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CARD, Chip, LiveStatus, Loading, PAGE_BODY, fmtDate } from '@/components/panel/kit';
import { usePanel } from '@/components/panel/panel-session';
import { PHOTO_TYPES, inspectionsApi, uploadInspectionPhoto } from '@/lib/panel-api';
import { errorMessage } from '@/lib/site-api';
import {
  CATEGORY_NAME,
  INSPECTION_STATUS,
  RESULTS,
  RESULT_NAME,
  ResultBadge,
  ResultIcon,
  fmtInstant,
  inspectorOf,
} from './equipment-kit';

type Photo = InspectionDetail['photos'][number];

/**
 * Inspección preoperacional (Fase 7.5c; maqueta 7.5, pantalla 7), pensada para el celular: progreso, cuatro
 * resultados grandes por elemento (color, ícono y texto), cantidad encontrada, observación y fotos. Cada cambio se
 * guarda al momento (salir no pierde nada). Completar pide confirmar un resumen; completada, es de solo lectura y se
 * corrige con una rectificación. Opcional: no condiciona viajes ni ventas.
 */
export function InspectionView({ id }: { id: string }) {
  const { can } = usePanel();
  const router = useRouter();
  const canPerform = can('inspections.perform');
  const [data, setData] = useState<InspectionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<'complete' | 'discard' | 'rectify' | null>(null);

  useEffect(() => {
    setData(null);
    inspectionsApi
      .get(id)
      .then(setData)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [id]);

  /**
   * Guarda y toma la respuesta de la API como la verdad (conteos, fotos y resultados). En cola: al tocar un resultado
   * justo después de escribir, el guardado del campo (al perder el foco) va antes y no pisa al del resultado.
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = useCallback((run: () => Promise<InspectionDetail>, message?: string) => {
    const next = queue.current.then(async () => {
      setActionError(null);
      try {
        setData(await run());
        if (message) setStatus(message);
        return true;
      } catch (e) {
        setActionError(errorMessage(e));
        return false;
      }
    });
    queue.current = next;
    return next;
  }, []);

  if (!data) {
    return (
      <div className={PAGE_BODY}>{error ? <Alert>{error}</Alert> : <Loading what="la inspección" />}</div>
    );
  }

  const draft = data.status === 'DRAFT';
  const editable = draft && canPerform;
  const done = data.items.filter((i) => i.result !== null).length;
  const total = data.items.length;
  const missing = total - done;
  const st = INSPECTION_STATUS[data.status];
  const generalPhotos = data.photos.filter((p) => p.itemId === null);

  return (
    <>
      <header className="flex flex-col gap-1.5 bg-rail px-4 py-4 text-on-rail sm:px-8 lg:px-10">
        <div className="flex items-center justify-between gap-2">
          <Link
            href={`/panel/flota?vehiculo=${data.vehicleId}`}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-on-rail underline underline-offset-4"
          >
            {editable ? '← Salir (se guarda)' : '← Flota'}
          </Link>
          <span className="rounded-full bg-rail-track px-2.5 py-0.5 text-[0.8125rem] font-bold">
            {st.label}
          </span>
        </div>
        <h1 className="font-display text-[1.375rem] font-extrabold tracking-[-0.02em]">
          Inspección · {data.vehicleCode}
        </h1>
        <p className="text-[0.8125rem] text-on-rail-muted">
          {data.vehicleName} · {data.vehicleRegistration} ·{' '}
          {data.trip ? `Viaje ${data.trip.code}` : 'Sin viaje'} · {inspectorOf(data)} ·{' '}
          {fmtInstant(data.completedAt ?? data.startedAt)}
        </p>
        {draft && (
          <div className="mt-1 flex flex-col gap-1.5">
            <span id="ins-progress" className="text-[0.8125rem] font-semibold">
              {done} de {total} elementos marcados
            </span>
            <div
              role="progressbar"
              aria-labelledby="ins-progress"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={done}
              className="h-2 overflow-hidden rounded-full bg-rail-track"
            >
              <div
                className="h-full bg-rail-accent transition-[width] duration-[var(--motion-quick)]"
                style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }}
              />
            </div>
          </div>
        )}
      </header>
      <LiveStatus message={status} />

      <div className="flex w-full max-w-[44rem] flex-col gap-3 px-3 py-4 sm:px-8">
        {actionError && <Alert>{actionError}</Alert>}
        {data.rectifiesId && (
          <p className="text-sm">
            Rectifica la{' '}
            <Link href={`/panel/inspecciones/${data.rectifiesId}`} className={LINK}>
              inspección original
            </Link>
            {data.rectificationReason ? `. Motivo: ${data.rectificationReason}` : ''}
          </p>
        )}
        {data.rectifiedBy.length > 0 && (
          <p className="text-sm">
            <strong>Rectificada.</strong> La corrección está en{' '}
            {data.rectifiedBy.map((r, i) => (
              <span key={r}>
                {i > 0 && ', '}
                <Link href={`/panel/inspecciones/${r}`} className={LINK}>
                  la rectificación{data.rectifiedBy.length > 1 ? ` ${i + 1}` : ''}
                </Link>
              </span>
            ))}
            ; esta queda como se registró.
          </p>
        )}
        {!draft && data.counts && (
          <section aria-label="Resumen" className={CARD}>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={st.tone}>{st.label}</Chip>
              <span className="text-sm">
                {data.counts.conforming} conformes · {data.counts.observed} observados ·{' '}
                {data.counts.notOperational} no operativos · {data.counts.notAvailable} no disponibles
              </span>
            </div>
            {canPerform && (
              <div>
                <button type="button" className={SECONDARY} onClick={() => setDialog('rectify')}>
                  Rectificar
                </button>
              </div>
            )}
          </section>
        )}

        {data.items.map((item) => (
          <ItemCard
            key={item.id}
            inspection={data}
            item={item}
            editable={editable}
            photos={data.photos.filter((p) => p.itemId === item.id)}
            onSave={save}
          />
        ))}

        <section aria-labelledby="h-general" className={CARD}>
          <h2 id="h-general" className="text-base font-bold">
            Observaciones generales
          </h2>
          {editable ? (
            <NotesField
              value={data.generalNotes ?? ''}
              onSave={(v) => save(() => inspectionsApi.updateNotes(data.id, v.trim() || null))}
            />
          ) : (
            <p className="text-sm whitespace-pre-line">
              {data.generalNotes ?? 'Sin observaciones generales.'}
            </p>
          )}
          <Photos
            inspection={data}
            itemId={null}
            label="Fotos generales"
            photos={generalPhotos}
            limit={EQUIPMENT_LIMITS.photosGeneral}
            editable={editable}
            onSave={save}
          />
        </section>

        <p className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
          {data.disclaimer} Al completarla ya no se edita: se corrige con una rectificación.
        </p>
        {editable && (
          <div>
            <button type="button" className={DANGER_LINK} onClick={() => setDialog('discard')}>
              Descartar borrador
            </button>
          </div>
        )}
      </div>

      {editable && (
        <footer className="sticky bottom-0 mt-auto flex flex-col gap-1.5 border-t border-divider bg-raised px-4 pt-3 pb-4 sm:px-8">
          <button
            type="button"
            className={`${PRIMARY} min-h-13 w-full max-w-[44rem] text-base`}
            disabled={missing > 0}
            aria-describedby="why-complete"
            onClick={() => setDialog('complete')}
          >
            Completar inspección
          </button>
          <span id="why-complete" className="max-w-[44rem] text-center text-[0.8125rem] text-ink-muted">
            {missing > 0
              ? `Falta marcar ${missing} ${missing === 1 ? 'elemento' : 'elementos'}.`
              : 'Verás un resumen para confirmar. Completada, ya no se edita.'}
          </span>
        </footer>
      )}

      {dialog === 'complete' && (
        <CompleteDialog
          inspection={data}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const ok = await save(() => inspectionsApi.complete(data.id), 'Inspección completada');
            setDialog(null);
            if (ok) window.scrollTo({ top: 0 });
          }}
        />
      )}
      {dialog === 'discard' && (
        <ConfirmDialog
          title="Descartar borrador"
          description="Se borran sus resultados y sus fotos. No se puede deshacer."
          label="Descartar"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              await inspectionsApi.discard(data.id);
              router.push(`/panel/flota?vehiculo=${data.vehicleId}`);
            } catch (e) {
              setActionError(errorMessage(e));
              setDialog(null);
            }
          }}
        />
      )}
      {dialog === 'rectify' && (
        <RectifyDialog
          inspection={data}
          onClose={() => setDialog(null)}
          onCreated={(nid) => router.push(`/panel/inspecciones/${nid}`)}
        />
      )}
    </>
  );
}

type SaveFn = (run: () => Promise<InspectionDetail>, message?: string) => Promise<boolean>;

function ItemCard({
  inspection,
  item,
  editable,
  photos,
  onSave,
}: {
  inspection: InspectionDetail;
  item: InspectionItem;
  editable: boolean;
  photos: Photo[];
  onSave: SaveFn;
}) {
  const headingId = useId();
  const [found, setFound] = useState(item.foundQuantity?.toString() ?? '');
  const [observation, setObservation] = useState(item.observation ?? '');
  const hasDetail = item.foundQuantity !== null || item.observation !== null || photos.length > 0;
  const [open, setOpen] = useState(hasDetail);
  const showDetail = open || (item.result !== null && item.result !== 'CONFORMING') || hasDetail;

  const put = (result: InspectionResult | null, foundQ: string, obs: string, message?: string) =>
    onSave(
      () =>
        inspectionsApi.updateItem(inspection.id, item.id, {
          result,
          foundQuantity: foundQ.trim() === '' ? null : Number(foundQ),
          observation: obs.trim() || null,
        }),
      message,
    );

  const suggestion = suggestedResult(item.declaredQuantity, found.trim() === '' ? null : Number(found));
  const meta = [
    CATEGORY_NAME[item.category],
    item.serialNumber && `serie ${item.serialNumber}`,
    item.expiresOn && `vence el ${fmtDate(item.expiresOn)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section aria-labelledby={headingId} className={`${CARD} gap-2.5 p-4`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-base font-bold">
          {item.name}
        </h2>
        <span className="text-[0.8125rem] whitespace-nowrap text-ink-muted">
          Declarado: {item.declaredQuantity}
        </span>
      </div>
      <span className="-mt-1.5 text-[0.8125rem] text-ink-muted">{meta}</span>

      {editable ? (
        <div role="group" aria-label={`Resultado de ${item.name}`} className="grid grid-cols-2 gap-2">
          {RESULTS.map((r) => {
            const on = item.result === r.id;
            return (
              <button
                key={r.id}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  void put(
                    on ? null : r.id,
                    found,
                    observation,
                    on ? `${item.name}: sin marcar` : `${item.name}: ${r.label}`,
                  )
                }
                className={`flex min-h-12 items-center justify-center gap-2 rounded-[10px] text-sm font-bold ${
                  on ? `border-2 ${r.solid}` : `border ${r.soft}`
                }`}
              >
                <ResultIcon>{r.icon}</ResultIcon>
                {r.label}
              </button>
            );
          })}
        </div>
      ) : item.result ? (
        <div>
          <ResultBadge result={item.result} />
        </div>
      ) : (
        <span className="text-sm text-ink-muted">Sin marcar</span>
      )}

      {editable && !showDetail && (
        <button type="button" className={`${LINK} min-h-11 self-start text-sm`} onClick={() => setOpen(true)}>
          Agregar cantidad, observación o fotos
        </button>
      )}

      {editable && showDetail && (
        <div className="flex flex-col gap-3">
          <label className="flex items-center justify-between gap-3 text-sm font-semibold">
            Cantidad encontrada
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={100000}
              value={found}
              onChange={(e) => setFound(e.target.value)}
              onBlur={() => {
                if (found !== (item.foundQuantity?.toString() ?? ''))
                  void put(item.result, found, observation);
              }}
              aria-describedby={`${headingId}-sug`}
              className="min-h-11 w-24 rounded-[var(--radius-control)] border border-control bg-raised px-3 text-base font-normal"
            />
          </label>
          <p id={`${headingId}-sug`} className="-mt-1.5 text-[0.8125rem] text-ink-muted">
            {suggestion && suggestion !== item.result ? (
              <>
                Sugerido: <strong className="text-ink">{RESULT_NAME[suggestion]}</strong>
                {suggestion === 'OBSERVED' ? ' (se encontró menos de lo declarado)' : ''}. Tú decides.{' '}
                <button
                  type="button"
                  className={`${LINK} min-h-11`}
                  onClick={() =>
                    void put(suggestion, found, observation, `${item.name}: ${RESULT_NAME[suggestion]}`)
                  }
                >
                  Marcar {RESULT_NAME[suggestion].toLowerCase()}
                </button>
              </>
            ) : (
              'Opcional.'
            )}
          </p>
          <Textarea
            label="Observación"
            rows={2}
            maxLength={500}
            value={observation}
            onChange={(e) => setObservation(e.target.value)}
            onBlur={() => {
              if (observation.trim() !== (item.observation ?? '')) void put(item.result, found, observation);
            }}
          />
          <Photos
            inspection={inspection}
            itemId={item.id}
            label={`Fotos de ${item.name}`}
            photos={photos}
            limit={EQUIPMENT_LIMITS.photosPerItem}
            editable
            onSave={onSave}
          />
        </div>
      )}

      {!editable && (item.foundQuantity !== null || item.observation || photos.length > 0) && (
        <div className="flex flex-col gap-2 text-sm">
          {item.foundQuantity !== null && (
            <span>
              Encontrado: {item.foundQuantity} de {item.declaredQuantity}
            </span>
          )}
          {item.observation && <span className="whitespace-pre-line">{item.observation}</span>}
          <Photos
            inspection={inspection}
            itemId={item.id}
            label={`Fotos de ${item.name}`}
            photos={photos}
            limit={EQUIPMENT_LIMITS.photosPerItem}
            editable={false}
            onSave={onSave}
          />
        </div>
      )}
    </section>
  );
}

function NotesField({ value, onSave }: { value: string; onSave: (v: string) => Promise<boolean> }) {
  const [text, setText] = useState(value);
  return (
    <Textarea
      label="Notas (opcional)"
      rows={3}
      maxLength={2000}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() !== value) void onSave(text);
      }}
    />
  );
}

/** Fotos de un elemento o generales: miniaturas privadas (con sesión), agregar desde la cámara y quitar. */
function Photos({
  inspection,
  itemId,
  label,
  photos,
  limit,
  editable,
  onSave,
}: {
  inspection: InspectionDetail;
  itemId: string | null;
  label: string;
  photos: Photo[];
  limit: number;
  editable: boolean;
  onSave: SaveFn;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!editable && photos.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {photos.length > 0 && (
        <ul aria-label={label} className="flex flex-wrap gap-2">
          {photos.map((p, i) => (
            <li key={p.id} className="flex flex-col items-start gap-1">
              <img
                src={inspectionsApi.photoUrl(inspection.id, p.id)}
                alt={`${label}, ${i + 1} de ${photos.length}`}
                className="size-24 rounded-[var(--radius-control)] border border-divider object-cover"
              />
              {editable && (
                <button
                  type="button"
                  className="min-h-11 text-[0.8125rem] font-semibold underline underline-offset-4"
                  aria-label={`Quitar la foto ${i + 1} de ${label.replace(/^Fotos /, '')}`}
                  onClick={() =>
                    void onSave(() => inspectionsApi.removePhoto(inspection.id, p.id), 'Foto quitada')
                  }
                >
                  Quitar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <>
          <input
            ref={input}
            type="file"
            accept={PHOTO_TYPES.join(',')}
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setBusy(true);
              void onSave(() => uploadInspectionPhoto(inspection.id, itemId, file), 'Foto agregada').finally(
                () => setBusy(false),
              );
            }}
          />
          <button
            type="button"
            disabled={busy || photos.length >= limit}
            aria-busy={busy || undefined}
            onClick={() => input.current?.click()}
            className="min-h-11 rounded-[var(--radius-control)] border border-dashed border-control bg-raised text-sm font-semibold disabled:opacity-60"
          >
            {busy
              ? 'Subiendo la foto…'
              : `Agregar foto (${photos.length} de ${limit})${itemId ? '' : ' · general'}`}
          </button>
        </>
      )}
    </div>
  );
}

function CompleteDialog({
  inspection,
  onClose,
  onConfirm,
}: {
  inspection: InspectionDetail;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const by = (r: InspectionResult) => inspection.items.filter((i) => i.result === r);
  const flagged = inspection.items.filter((i) => i.result !== 'CONFORMING');
  return (
    <Dialog
      title="Completar inspección"
      description="Revisa el resumen. Completada, ya no se edita: se corrige con una rectificación."
      onRequestClose={onClose}
    >
      <dl className="grid grid-cols-2 gap-2 text-sm">
        {RESULTS.map((r) => (
          <div
            key={r.id}
            className={`flex flex-col gap-0.5 rounded-[var(--radius-control)] border p-2.5 ${r.soft}`}
          >
            <dt className="flex items-center gap-1.5 font-semibold">
              <ResultIcon>{r.icon}</ResultIcon>
              {r.label}
            </dt>
            <dd className="text-xl font-extrabold">{by(r.id).length}</dd>
          </div>
        ))}
      </dl>
      {flagged.length > 0 ? (
        <div className="flex flex-col gap-1.5 text-sm">
          <span className="font-semibold">Con observaciones ({flagged.length})</span>
          <ul className="flex flex-col gap-1">
            {flagged.map((i) => (
              <li key={i.id}>
                {i.name}: {RESULT_NAME[i.result!].toLowerCase()}
                {i.observation ? ` — ${i.observation}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm">Todos los elementos están conformes.</p>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        <button type="button" className={SECONDARY} onClick={onClose}>
          Seguir revisando
        </button>
        <button
          type="button"
          className={PRIMARY}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => {
            setBusy(true);
            void onConfirm();
          }}
        >
          {busy ? 'Completando…' : 'Confirmar y completar'}
        </button>
      </div>
    </Dialog>
  );
}

function ConfirmDialog({
  title,
  description,
  label,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  label: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={title} description={description} onRequestClose={onClose}>
      <div className="flex flex-wrap justify-end gap-3">
        <button type="button" className={SECONDARY} onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className={PRIMARY}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => {
            setBusy(true);
            void onConfirm();
          }}
        >
          {label}
        </button>
      </div>
    </Dialog>
  );
}

/** Rectificación: una inspección nueva que copia lo verificado en la original y hereda su viaje. */
function RectifyDialog({
  inspection,
  onClose,
  onCreated,
}: {
  inspection: InspectionDetail;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title="Rectificar inspección"
      description="Se crea una inspección nueva con los mismos elementos; esta queda visible tal como se registró."
      onRequestClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          inspectionsApi
            .create({
              vehicleId: inspection.vehicleId,
              tripId: null,
              rectifiesId: inspection.id,
              rectificationReason: reason.trim(),
            })
            .then((r) => onCreated(r.id))
            .catch((err: unknown) => {
              setError(errorMessage(err));
              setBusy(false);
            });
        }}
      >
        {error && <Alert>{error}</Alert>}
        <Textarea
          label="Motivo"
          rows={2}
          required
          minLength={3}
          maxLength={300}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Por ejemplo, «se marcó no operativo un extintor que estaba conforme»."
        />
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className={PRIMARY} disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Creando…' : 'Crear rectificación'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
