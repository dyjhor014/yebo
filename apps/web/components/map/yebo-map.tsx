'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import type * as MaplibreModule from 'maplibre-gl';
import type { LngLatBoundsLike, Map as MlMap, StyleSpecification } from 'maplibre-gl';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Mapa propio de YEBO (Fase 7.6; F7-Q9, M-Q1 a M-Q7, maqueta 7.6 aprobada): MapLibre con el PMTiles del Perú, sus
 * fuentes y sus sprites, todo en `/mapa/` del mismo origen. Ninguna petición a otros dominios. MapLibre, PMTiles y
 * el estilo se cargan con `import()` solo cuando una pantalla muestra un mapa. Sin el archivo del mapa (M-Q7), las
 * pantallas lo dicen en una línea y siguen con la lista y los campos.
 */

export type Maplibre = typeof MaplibreModule;
export type MapStatus = 'checking' | 'missing' | 'loading' | 'ready' | 'error';

/** El Perú con un margen: el mapa no se sale de aquí. */
export const PERU_BOUNDS: [[number, number], [number, number]] = [
  [-83.5, -19.5],
  [-66.5, 1.5],
];

const MAP_FILE = '/mapa/peru.pmtiles';
const WORKER = '/vendor/maplibre-gl-worker-6.16.0.mjs';

/** Colores de las capas de YEBO (maqueta 7.6; contraste ≥ 3:1 sobre tierra y agua, medido). */
export const MAP_COLORS = {
  light: {
    trace: '#101d2b',
    straight: '#59626c',
    stop: '#101d2b',
    onStop: '#ffffff',
    halo: '#ffffff',
    draw: '#0b6b61',
  },
  dark: {
    trace: '#16c7b2',
    straight: '#b3b9bc',
    stop: '#16c7b2',
    onStop: '#101d2b',
    halo: '#101d2b',
    draw: '#c5f36b',
  },
} as const;
export type MapTheme = keyof typeof MAP_COLORS;

let available: Promise<boolean> | null = null;
/** ¿Está instalado el mapa en este servidor? (una sola consulta por carga de página). */
export function mapAvailable(): Promise<boolean> {
  available ??= fetch(MAP_FILE, { method: 'HEAD', cache: 'no-store' })
    .then((r) => r.ok)
    .catch(() => false);
  return available;
}

let lib: Promise<{ ml: Maplibre; style: (theme: MapTheme) => StyleSpecification }> | null = null;
function loadLib() {
  lib ??= (async () => {
    const [ml, pmtiles, basemaps] = await Promise.all([
      import('maplibre-gl'),
      import('pmtiles'),
      import('@protomaps/basemaps'),
    ]);
    ml.setWorkerUrl(WORKER);
    const protocol = new pmtiles.Protocol();
    ml.addProtocol('pmtiles', protocol.tile);
    const origin = window.location.origin;
    const style = (theme: MapTheme): StyleSpecification => ({
      version: 8,
      glyphs: `${origin}/mapa/fuentes/{fontstack}/{range}.pbf`,
      sprite: `${origin}/mapa/sprites/v4/${theme}`,
      sources: {
        protomaps: {
          type: 'vector',
          url: `pmtiles://${origin}${MAP_FILE}`,
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        },
      },
      layers: basemaps.layers('protomaps', basemaps.namedFlavor(theme), { lang: 'es' }),
    });
    return { ml, style };
  })();
  return lib;
}

function currentTheme(): MapTheme {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark' || t === 'light') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Textos de los controles de MapLibre en español. */
const LOCALE = {
  'NavigationControl.ZoomIn': 'Acercar',
  'NavigationControl.ZoomOut': 'Alejar',
  'NavigationControl.ResetBearing': 'Orientar al norte',
  'AttributionControl.ToggleAttribution': 'Mostrar u ocultar la atribución',
  'AttributionControl.MapFeedback': 'Corregir el mapa',
  'Marker.Title': 'Marcador',
  'Popup.Close': 'Cerrar',
};

export type MapReady = { map: MlMap; ml: Maplibre; theme: MapTheme };

/**
 * Contenedor del mapa. `label` describe en texto lo que muestra (para lectores de pantalla: el mapa nunca es el
 * único modo de hacer algo). `onReady` recibe el mapa cuando el estilo cargó, para agregar las capas de YEBO.
 */
export function YeboMap({
  label,
  bounds,
  center,
  zoom = 12,
  onReady,
  className = 'h-80 sm:h-[26rem]',
  children,
}: {
  label: string;
  bounds?: LngLatBoundsLike;
  center?: [number, number];
  zoom?: number;
  onReady: (r: MapReady) => void | (() => void);
  className?: string;
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<MapStatus>('checking');
  const ready = useRef(onReady);
  ready.current = onReady;
  const view = useRef({ bounds, center, zoom });

  useEffect(() => {
    let map: MlMap | null = null;
    let cleanup: void | (() => void);
    let gone = false;
    void (async () => {
      if (!(await mapAvailable())) return !gone && setStatus('missing');
      setStatus('loading');
      try {
        const { ml, style } = await loadLib();
        if (gone || !box.current) return;
        const theme = currentTheme();
        const v = view.current;
        map = new ml.Map({
          container: box.current,
          style: style(theme),
          maxBounds: PERU_BOUNDS,
          ...(v.center ? { center: v.center, zoom: v.zoom } : { bounds: v.bounds ?? PERU_BOUNDS }),
          fitBoundsOptions: { padding: 40, maxZoom: 13 },
          attributionControl: { compact: false },
          dragRotate: false,
          pitchWithRotate: false,
          locale: LOCALE,
        });
        map.touchZoomRotate.disableRotation();
        map.keyboard.disableRotation();
        map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
        map.on('load', () => {
          if (gone || !map) return;
          setStatus('ready');
          cleanup = ready.current({ map, ml, theme });
        });
        map.on('error', (e) => {
          // Una tesela o una letra que falta no es un error del mapa; solo si no llegó a cargar.
          if (!map?.loaded()) console.warn('Mapa:', e.error?.message);
        });
      } catch {
        if (!gone) setStatus('error');
      }
    })();
    return () => {
      gone = true;
      if (typeof cleanup === 'function') cleanup();
      map?.remove();
    };
  }, []);

  // El lienzo de MapLibre se nombra con la descripción en texto de lo que muestra.
  useEffect(() => {
    box.current?.querySelector('canvas')?.setAttribute('aria-label', label);
  }, [label, status]);

  if (status === 'missing' || status === 'error') {
    return (
      <p role="note" className="rounded-[var(--radius-control)] bg-ink/8 px-3.5 py-3 text-sm leading-5">
        {status === 'missing'
          ? 'El mapa no está instalado en este servidor. Todo se puede hacer igual desde la lista y los campos.'
          : 'No se pudo cargar el mapa. Todo se puede hacer igual desde la lista y los campos.'}
      </p>
    );
  }
  return (
    <div className="relative">
      <div
        ref={box}
        className={`yebo-map overflow-hidden rounded-[10px] border border-divider bg-canvas ${className}`}
      />
      {status !== 'ready' && (
        <p role="status" className="absolute inset-0 grid place-items-center text-sm text-ink-muted">
          Cargando el mapa…
        </p>
      )}
      {children}
    </div>
  );
}

/** «-7.334170» → número con 6 decimales (como guarda la API). */
export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
