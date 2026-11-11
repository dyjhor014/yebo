'use client';

import { siteAssetUrl, type SiteAssetKind } from '@yebo/contracts';
import { INPUT, SECONDARY } from '@yebo/ui/form';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ACCEPTED_IMAGES, errorMessage, uploadAsset } from '@/lib/site-api';

const HEX = /^#[0-9a-fA-F]{6}$/;
export const fmtRatio = (r: number) => r.toFixed(1).replace('.', ',');

export const CARD = 'flex flex-col gap-5 rounded-xl border border-divider bg-raised p-5';
export const CARD_TITLE = 'font-display text-lg font-extrabold tracking-[-0.01em]';
const ICON_BUTTON =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-ink hover:bg-ink/5 disabled:cursor-default disabled:text-ink/40 disabled:hover:bg-transparent';
export const REMOVE =
  'inline-flex min-h-11 items-center rounded-[var(--radius-control)] px-2.5 text-sm font-semibold text-danger underline underline-offset-4 hover:bg-danger-surface';

/**
 * Color del tema: selector y valor #RRGGBB. El valor escrito solo pasa al borrador cuando es un color completo. El
 * contraste (misma regla que la API) se ve siempre: en una línea discreta si se lee bien y en un aviso si no. Al
 * lector de pantalla solo se le anuncia cuando cambia de «se lee bien» a «no se lee» (o al revés), no en cada
 * movimiento del selector de color.
 */
export function ColorField({
  label,
  hint,
  path,
  value,
  onChange,
  ok,
  okText,
  problem,
}: {
  label: string;
  hint: string;
  /** Ruta del campo en el borrador (`theme.accent`), para llevarle el foco desde el resumen de problemas. */
  path: string;
  value: string;
  onChange: (hex: string) => void;
  ok: boolean;
  okText: string;
  problem: string | null;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const invalid = !HEX.test(text);
  const good = ok && !invalid;
  const message = invalid ? 'Escribe el color como #RRGGBB (por ejemplo, #16C7B2).' : good ? okText : problem;
  // Anuncio solo en los cambios de estado, y cuando el usuario deja de mover el selector.
  const [announced, setAnnounced] = useState('');
  const last = useRef(good);
  useEffect(() => {
    if (last.current === good) return;
    const t = setTimeout(() => {
      last.current = good;
      setAnnounced(`${label}: ${message ?? ''}`);
    }, 700);
    return () => clearTimeout(t);
  }, [good, label, message]);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <span className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          aria-label={`Elegir el ${label.toLowerCase()}`}
          className="size-11 shrink-0 cursor-pointer rounded-[var(--radius-control)] border border-control bg-raised p-0.5"
        />
        <input
          id={id}
          value={text}
          spellCheck={false}
          maxLength={7}
          data-path={path}
          onChange={(e) => {
            const next = e.target.value.trim();
            setText(next);
            if (HEX.test(next)) onChange(next.toUpperCase());
          }}
          onBlur={() => !HEX.test(text) && setText(value)}
          aria-invalid={good ? undefined : true}
          aria-describedby={`${id}-m ${id}-h`}
          className={`${INPUT} font-mono`}
        />
      </span>
      <span id={`${id}-h`} className="text-[0.8125rem] text-ink-muted">
        {hint}
      </span>
      {good ? (
        <p id={`${id}-m`} className="flex items-start gap-1.5 text-[0.8125rem] leading-[1.125rem]">
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="mt-px size-4 shrink-0 text-ink"
          >
            <path d="m4 10.5 4 4 8-9" />
          </svg>
          {message}
        </p>
      ) : (
        <p
          id={`${id}-m`}
          className="rounded-[var(--radius-control)] bg-danger-surface px-3 py-2.5 text-sm leading-5 font-semibold text-danger"
        >
          {message}
        </p>
      )}
      <span role="status" className="sr-only">
        {announced}
      </span>
    </div>
  );
}

/**
 * Pestañas del editor (`tablist`, con flechas, Inicio y Fin): una sola fila subrayada, distinta de las opciones en
 * píldora. Tras intentar guardar, cada pestaña muestra cuántos datos hay que corregir en ella.
 */
export function Tabs<T extends string>({
  label,
  value,
  tabs,
  errors,
  onChange,
  idFor,
}: {
  label: string;
  value: T;
  tabs: readonly { id: T; label: string }[];
  /** Datos por corregir en cada pestaña (solo se muestran si hay alguno). */
  errors: Partial<Record<T, number>>;
  onChange: (v: T) => void;
  /** id del botón de cada pestaña (el panel lo usa en `aria-labelledby`). */
  idFor: (v: T) => string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const go = (i: number) => {
    const next = tabs[(i + tabs.length) % tabs.length];
    if (!next) return;
    onChange(next.id);
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(idFor(next.id))}`)?.focus();
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className="flex overflow-x-auto border-b border-divider"
      onKeyDown={(e) => {
        const i = tabs.findIndex((t) => t.id === value);
        const key = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (key === undefined) return;
        e.preventDefault();
        go(key);
      }}
    >
      {tabs.map((t) => {
        const on = t.id === value;
        const n = errors[t.id] ?? 0;
        return (
          <button
            key={t.id}
            id={idFor(t.id)}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={`${idFor(t.id)}-panel`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`-mb-px inline-flex min-h-11 shrink-0 items-center gap-1.5 border-b-[3px] px-2 text-sm font-semibold whitespace-nowrap ${
              on ? 'border-action text-ink' : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {t.label}
            {n > 0 && (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-xs leading-5 font-bold text-danger-surface">
                {n}
                <span className="sr-only"> {n === 1 ? 'dato por corregir' : 'datos por corregir'}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Opciones de valor único (fondo del sitio, dispositivo de la vista previa): `aria-pressed` y aspecto de píldora. */
export function Pills<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold ${
              on ? 'border-ink bg-ink text-canvas' : 'border-control bg-raised text-ink hover:bg-ink/5'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Imagen del sitio (logo o portada): sube, cambia o quita. La API comprueba el contenido, quita los metadatos y la
 * recodifica; aquí solo se filtra el tipo y el tamaño para avisar antes.
 */
export function ImageField({
  kind,
  label,
  hint,
  assetId,
  onChange,
}: {
  kind: SiteAssetKind;
  label: string;
  hint: string;
  assetId: string | null;
  onChange: (id: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const name = kind === 'logo' ? 'el logo' : 'la imagen de portada';
  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange((await uploadAsset(kind, file)).id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {assetId ? (
          <img
            src={siteAssetUrl(assetId)}
            alt={`Vista de ${name}`}
            className={`rounded-[var(--radius-control)] border border-divider bg-canvas object-contain ${
              kind === 'logo' ? 'h-14 w-40 p-1.5' : 'aspect-[3/2] w-40 object-cover'
            }`}
          />
        ) : (
          <span className="flex h-14 w-40 items-center justify-center rounded-[var(--radius-control)] border border-dashed border-control text-[0.8125rem] text-ink-muted">
            Sin {kind === 'logo' ? 'logo' : 'imagen'}
          </span>
        )}
        <input
          ref={input}
          type="file"
          accept={ACCEPTED_IMAGES.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => void upload(e.target.files?.[0])}
        />
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy}
          aria-busy={busy || undefined}
          aria-describedby={hintId}
          className={SECONDARY}
        >
          {busy
            ? 'Subiendo…'
            : assetId
              ? `Cambiar ${kind === 'logo' ? 'logo' : 'imagen'}`
              : `Subir ${kind === 'logo' ? 'logo' : 'imagen'}`}
        </button>
        {assetId && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={`Quitar ${name}`}
            className={REMOVE}
          >
            Quitar
          </button>
        )}
      </div>
      <span id={hintId} className="text-[0.8125rem] leading-[1.125rem] text-ink-muted">
        {hint}
      </span>
      {error && (
        <p role="alert" className="text-[0.8125rem] font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Lista editable (teléfonos, sucursales, horarios, preguntas, políticas): cada elemento en su grupo con nombre, y
 * «Quitar» y «Añadir» con nombres que dicen a qué se refieren. Al añadir, el foco va al primer campo del nuevo; al
 * quitar, se puede deshacer (una política puede tener miles de caracteres). Cada fila tiene una clave estable: al
 * quitar una intermedia, el foco y lo escrito no saltan a la fila equivocada.
 */
export function ListEditor<T>({
  title,
  noun,
  items,
  max,
  make,
  onChange,
  render,
  preview,
}: {
  title: string;
  /** Nombre de un elemento, en minúsculas: «sucursal», «pregunta». */
  noun: string;
  items: T[];
  max: number;
  make: () => T;
  onChange: (items: T[]) => void;
  render: (item: T, set: (patch: Partial<T>) => void, index: number) => ReactNode;
  /** Sección del portal que muestra esta lista: la vista previa se desplaza a ella al editarla. */
  preview?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const added = useRef(false);
  const seq = useRef(0);
  const keys = useRef<number[]>([]);
  // Si la lista cambió desde fuera (cargar, descartar), las claves se rehacen.
  if (keys.current.length !== items.length) keys.current = items.map(() => seq.current++);
  const [removed, setRemoved] = useState<{ item: T; index: number; key: number } | null>(null);
  useEffect(() => {
    if (!added.current) return;
    added.current = false;
    list.current?.querySelector<HTMLElement>('fieldset:last-of-type :is(input, textarea)')?.focus();
  }, [items.length]);
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const remove = (i: number) => {
    const item = items[i];
    const key = keys.current[i];
    if (item === undefined || key === undefined) return;
    keys.current = keys.current.filter((_, j) => j !== i);
    setRemoved({ item, index: i, key });
    onChange(items.filter((_, j) => j !== i));
  };
  const undo = () => {
    if (!removed) return;
    const at = Math.min(removed.index, items.length);
    keys.current = [...keys.current.slice(0, at), removed.key, ...keys.current.slice(at)];
    onChange([...items.slice(0, at), removed.item, ...items.slice(at)]);
    setRemoved(null);
  };
  return (
    <div className="flex flex-col gap-3" data-preview={preview}>
      <h3 className="text-[0.9375rem] font-semibold">
        {title}{' '}
        <span className="font-normal text-ink-muted">
          · {items.length} de {max}
        </span>
      </h3>
      {/* Filas separadas por una línea (no tarjetas dentro de la tarjeta de la sección). */}
      <div ref={list} className="flex flex-col border-b border-divider empty:border-b-0">
        {items.map((item, i) => (
          // La leyenda flota (sin el hueco de borde de un fieldset); los campos van debajo (clear).
          <fieldset key={keys.current[i]} className="border-t border-divider pt-1 pb-4">
            <legend className="float-left min-h-11 content-center text-sm font-semibold">
              {Noun} {i + 1}
            </legend>
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label={`Quitar ${noun} ${i + 1}`}
              className={`${REMOVE} float-right`}
            >
              Quitar
            </button>
            <div className="clear-both flex flex-col gap-3 pt-1">
              {render(item, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))), i)}
            </div>
          </fieldset>
        ))}
      </div>
      <div aria-live="polite" className="empty:hidden">
        {removed && (
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-muted">
            Se quitó: {noun} {removed.index + 1}.
            <button
              type="button"
              onClick={undo}
              className="inline-flex min-h-11 items-center px-1 font-semibold text-ink underline underline-offset-4"
            >
              Deshacer
            </button>
          </p>
        )}
      </div>
      {items.length < max && (
        <button
          type="button"
          onClick={() => {
            added.current = true;
            setRemoved(null);
            keys.current = [...keys.current, seq.current++];
            onChange([...items, make()]);
          }}
          className={`${SECONDARY} self-start`}
        >
          Añadir {noun}
        </button>
      )}
    </div>
  );
}

/** Subir y bajar una sección: los extremos quedan desactivados. */
export function MoveButtons({
  label,
  first,
  last,
  onMove,
}: {
  label: string;
  first: boolean;
  last: boolean;
  onMove: (delta: -1 | 1) => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => onMove(-1)}
        disabled={first}
        aria-label={`Subir ${label}`}
        className={ICON_BUTTON}
      >
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="size-[1.125rem]"
        >
          <path d="m5 12.5 5-5 5 5" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => onMove(1)}
        disabled={last}
        aria-label={`Bajar ${label}`}
        className={ICON_BUTTON}
      >
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="size-[1.125rem]"
        >
          <path d="m5 7.5 5 5 5-5" />
        </svg>
      </button>
    </>
  );
}
