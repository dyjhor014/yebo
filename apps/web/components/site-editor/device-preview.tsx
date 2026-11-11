'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export type Device = 'desktop' | 'phone';

/** Pantalla que se simula: el portal se pinta a su tamaño real y se reduce para caber (maqueta 5.4 aprobada). */
const SCREEN = {
  desktop: { width: 1280, height: 800, bezel: 12, maxScale: 0.6 },
  phone: { width: 390, height: 844, bezel: 10, maxScale: 0.72 },
} as const;

/**
 * Vista previa del borrador dentro de un monitor (con la barra del navegador y su dirección) o de un iPhone (isla,
 * hora y barra de inicio). El portal se pinta a 1280 × 800 o 390 × 844 y se reduce: como sus cortes de diseño son de
 * contenedor, se ve exactamente como en ese dispositivo. Se puede desplazar dentro de la pantalla, pero no es
 * interactivo (`inert`): sus enlaces no se siguen ni reciben el foco, y no duplica títulos para los lectores de
 * pantalla.
 */
export function DevicePreview({
  device,
  address,
  dark,
  target = null,
  zoomed = false,
  children,
}: {
  device: Device;
  address: string;
  /** Superficie oscura del sitio: la barra de estado del iPhone va en claro. */
  dark: boolean;
  /**
   * Parte del portal que se está editando: `top`, `footer` o el id de una sección (`faq`, `contact`…). La pantalla
   * se desplaza hasta ella, para ver lo que se escribe sin buscarlo.
   */
  target?: string | null;
  /** A tamaño real si cabe (diálogo «Ampliar»): también se limita por el alto de la ventana. */
  zoomed?: boolean;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [viewport, setViewport] = useState(0);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry?.contentRect.width ?? 0));
    observer.observe(el);
    const height = () => setViewport(window.innerHeight);
    height();
    window.addEventListener('resize', height);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', height);
    };
  }, []);

  const s = SCREEN[device];
  // Ampliada: hasta el 100 % y sin pasar del alto de la ventana (marco, peana y pie incluidos).
  const byHeight = zoomed && viewport > 0 ? (viewport - 220) / s.height : Infinity;
  const scale =
    available > 0
      ? Math.max(0.2, Math.min(zoomed ? 1 : s.maxScale, byHeight, (available - 2 * s.bezel - 8) / s.width))
      : 0;

  // Una vez por destino: si la sección aún no existe (sin contenido), se reintenta en cada pintado hasta que
  // aparezca (al escribir su primer dato); después no se vuelve a mover, para no pelear con el desplazamiento manual.
  const reached = useRef<string | null>(null);
  useEffect(() => {
    const region = screen.current;
    const key = `${target}|${device}|${scale}`;
    if (!region || !target || scale === 0 || reached.current === key) return;
    const el =
      target === 'top'
        ? null
        : region.querySelector<HTMLElement>(target === 'footer' ? 'footer' : `#${CSS.escape(target)}`);
    if (target !== 'top' && !el) return;
    reached.current = key;
    const top = el
      ? region.scrollTop + (el.getBoundingClientRect().top - region.getBoundingClientRect().top) / scale
      : 0;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    region.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
  });
  const w = Math.round(s.width * scale);
  const h = Math.round(s.height * scale);
  const phone = device === 'phone';

  return (
    <div
      ref={frame}
      className="flex flex-col items-center overflow-hidden rounded-xl bg-ink/[0.07] px-3 pt-7 pb-6"
    >
      {scale > 0 && (
        <>
          <div
            className={
              phone
                ? 'rounded-[48px] bg-[#0e1216] p-[10px] shadow-[0_0_0_2px_#4a535c,0_20px_44px_rgb(16_29_43/0.28)]'
                : 'rounded-[14px] bg-[#1e252c] px-3 pt-3 pb-[22px] shadow-[0_18px_40px_rgb(16_29_43/0.22)]'
            }
          >
            <div
              className={`relative overflow-hidden bg-white ${phone ? 'rounded-[38px]' : 'rounded-[3px]'}`}
              style={{ width: w, height: h }}
            >
              <div
                className="flex flex-col"
                style={{
                  width: s.width,
                  height: s.height,
                  transform: `scale(${scale})`,
                  transformOrigin: '0 0',
                }}
              >
                {phone ? <PhoneStatusBar dark={dark} /> : <BrowserBar address={address} />}
                <div
                  ref={screen}
                  role="region"
                  aria-label={`Pantalla del ${phone ? 'iPhone' : 'monitor'}: usa las flechas para desplazarte`}
                  tabIndex={0}
                  className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] focus-visible:outline-[6px] focus-visible:outline-offset-[-6px]"
                >
                  <div inert>{children}</div>
                </div>
                {phone && (
                  <span
                    aria-hidden="true"
                    className={`absolute bottom-2 left-1/2 h-[5px] w-[136px] -translate-x-1/2 rounded-full ${dark ? 'bg-white' : 'bg-[#101d2b]'}`}
                  />
                )}
              </div>
            </div>
          </div>
          {!phone && (
            <div aria-hidden="true" className="flex flex-col items-center">
              <div className="h-11 w-[72px] bg-[#b9c0c5] [clip-path:polygon(14%_0,86%_0,100%_100%,0_100%)]" />
              <div className="h-2.5 w-[200px] rounded-t-md rounded-b-sm bg-[#a9b1b7]" />
            </div>
          )}
          <p className="mt-4 text-[0.8125rem] text-ink-muted">
            {phone ? 'iPhone' : 'Monitor'} · {s.width} × {s.height} px al {Math.round(scale * 100)} %
          </p>
        </>
      )}
    </div>
  );
}

function BrowserBar({ address }: { address: string }) {
  return (
    <div
      aria-hidden="true"
      className="flex shrink-0 items-center gap-[18px] border-b border-[#d8dcdd] bg-[#eef0f1] px-5 py-[11px] font-sans"
    >
      <span className="flex gap-2">
        <span className="size-[13px] rounded-full bg-[#e8685e]" />
        <span className="size-[13px] rounded-full bg-[#e9b949]" />
        <span className="size-[13px] rounded-full bg-[#62c554]" />
      </span>
      <span className="mx-auto flex h-[34px] max-w-[640px] flex-1 items-center justify-center gap-2 rounded-lg bg-white text-[17px] text-[#3a434c]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          className="size-3.5"
        >
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
        {address}
      </span>
      <span className="w-[57px]" />
    </div>
  );
}

function PhoneStatusBar({ dark }: { dark: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`flex h-[54px] shrink-0 items-center justify-between pr-7 pl-9 font-sans ${dark ? 'bg-[#101d2b] text-[#f3f6f5]' : 'bg-white text-[#101d2b]'}`}
    >
      <span className="text-base font-semibold">9:41</span>
      <span className="h-9 w-[124px] rounded-[20px] bg-black" />
      <span className="flex items-center gap-1.5">
        <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor">
          <rect x="0" y="8" width="3" height="4" rx="1" />
          <rect x="5" y="5" width="3" height="7" rx="1" />
          <rect x="10" y="2.5" width="3" height="9.5" rx="1" />
          <rect x="15" y="0" width="3" height="12" rx="1" />
        </svg>
        <svg width="26" height="13" viewBox="0 0 26 13" fill="none">
          <rect x="0.5" y="0.5" width="22" height="12" rx="3.5" stroke="currentColor" opacity="0.5" />
          <rect x="2.5" y="2.5" width="16" height="8" rx="2" fill="currentColor" />
          <rect x="24" y="4" width="1.6" height="5" rx="0.8" fill="currentColor" opacity="0.5" />
        </svg>
      </span>
    </div>
  );
}

/**
 * «Ampliar»: la vista previa a tamaño real (o lo más grande que quepa) en un diálogo modal casi a pantalla completa.
 * El `Dialog` de @yebo/ui tiene el ancho de un formulario; este ocupa la ventana. Esc o «Cerrar» vuelven al editor.
 */
export function PreviewZoom({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="ampliada-t"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto h-[calc(100dvh-2rem)] max-h-none w-[calc(100vw-2rem)] max-w-[90rem] rounded-2xl bg-raised p-0 text-ink shadow-[0_24px_64px_rgb(16_29_43/0.35)] backdrop:bg-[rgb(16_29_43/0.55)]"
    >
      <div className="flex h-full flex-col gap-3 overflow-y-auto px-5 pt-4 pb-5">
        <div className="flex items-center justify-between gap-4">
          <h2 id="ampliada-t" className="text-base font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border border-control-strong px-4 font-semibold hover:bg-ink/5"
          >
            Cerrar
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
