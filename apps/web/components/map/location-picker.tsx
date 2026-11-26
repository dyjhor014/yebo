'use client';

import type { Map as MlMap, Marker } from 'maplibre-gl';
import { useEffect, useId, useRef } from 'react';
import { MAP_COLORS, YeboMap, round6, type Maplibre, type MapTheme } from './yebo-map';

/**
 * Posición de una ubicación en el mapa (Fase 7.6, M-Q5; maqueta 7.6): clic en el mapa o arrastrar el marcador.
 * Latitud y longitud siguen como campos (el control accesible); el mapa los sigue cuando se escriben.
 */
export function LocationPicker({
  lat,
  lng,
  onPick,
}: {
  lat: number | null;
  lng: number | null;
  onPick: (lat: number, lng: number) => void;
}) {
  const hintId = useId();
  const pick = useRef(onPick);
  pick.current = onPick;
  const state = useRef<{ map: MlMap; ml: Maplibre; marker: Marker | null; theme: MapTheme } | null>(null);
  const valid = lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng);
  // La posición más reciente (lo escrito mientras el mapa cargaba se aplica al terminar de cargar).
  const latest = useRef<{ lng: number; lat: number } | null>(null);
  latest.current = valid ? { lng: lng!, lat: lat! } : null;

  const place = (p: { lng: number; lat: number }, fly: boolean) => {
    const s = state.current;
    if (!s) return;
    if (!s.marker) {
      const el = document.createElement('div');
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', 'Posición de la ubicación');
      el.className = 'yebo-pin';
      el.style.setProperty('--pin', MAP_COLORS[s.theme].stop);
      el.style.setProperty('--pin-halo', MAP_COLORS[s.theme].halo);
      s.marker = new s.ml.Marker({ element: el, draggable: true, anchor: 'bottom' })
        .setLngLat(p)
        .addTo(s.map);
      s.marker.on('dragend', () => {
        const at = s.marker!.getLngLat();
        pick.current(round6(at.lat), round6(at.lng));
      });
    } else {
      s.marker.setLngLat(p);
    }
    if (fly) s.map.easeTo({ center: p, zoom: Math.max(s.map.getZoom(), 12) });
  };

  // Lo escrito en los campos mueve el marcador.
  useEffect(() => {
    if (valid) place({ lng: lng!, lat: lat! }, true);
  }, [lat, lng, valid]);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Posición en el mapa</span>
      <YeboMap
        label={
          valid
            ? `Mapa con la posición de la ubicación: latitud ${lat}, longitud ${lng}. Se cambia también con los campos de latitud y longitud.`
            : 'Mapa del Perú, sin posición todavía. Se puede escribir la latitud y la longitud en sus campos.'
        }
        center={valid ? [lng!, lat!] : undefined}
        zoom={13}
        className="h-64 sm:h-72"
        onReady={({ map, ml, theme }) => {
          state.current = { map, ml, marker: null, theme };
          map.getCanvas().style.cursor = 'crosshair';
          map.getCanvas().setAttribute('aria-describedby', hintId);
          if (latest.current) {
            map.jumpTo({ center: latest.current, zoom: 13 });
            place(latest.current, false);
          }
          map.on('click', (e) => {
            place(e.lngLat, false);
            pick.current(round6(e.lngLat.lat), round6(e.lngLat.lng));
          });
          return () => {
            state.current = null;
          };
        }}
      >
        <p id={hintId} className="mt-2 text-[0.8125rem] leading-[1.125rem] text-ink-muted">
          Haz clic en el mapa o arrastra el marcador. También puedes escribir la latitud y la longitud: el
          mapa las sigue.
        </p>
      </YeboMap>
    </div>
  );
}
