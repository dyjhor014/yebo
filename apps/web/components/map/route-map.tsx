'use client';

import type { LngLat } from '@yebo/contracts';
import type { GeoJSONSource, Map as MlMap, MapMouseEvent, MapTouchEvent } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { MAP_COLORS, YeboMap, round6, type MapTheme } from './yebo-map';

export type MapStop = { name: string; lng: number | null; lat: number | null };
export type Drawing = { seg: number; points: LngLat[] };

type Feature = {
  type: 'Feature';
  properties: Record<string, string | number>;
  geometry: { type: 'LineString'; coordinates: LngLat[] } | { type: 'Point'; coordinates: LngLat };
};
type FC = { type: 'FeatureCollection'; features: Feature[] };
const fc = (features: Feature[]): FC => ({ type: 'FeatureCollection', features });
const at = (s: MapStop): LngLat | null => (s.lng === null || s.lat === null ? null : [s.lng, s.lat]);

/** Lo que muestra el mapa, en texto (para lectores de pantalla y como nombre del lienzo). */
export function routeMapLabel(stops: MapStop[], paths: (LngLat[] | null)[], drawing: Drawing | null): string {
  const located = stops.filter((s) => at(s)).length;
  const legs = stops.slice(0, -1).map((s, i) => {
    const next = stops[i + 1]!;
    const how =
      drawing?.seg === i
        ? 'dibujándose'
        : paths[i]
          ? 'con traza'
          : at(s) && at(next)
            ? 'en línea recta'
            : 'sin dibujar (falta ubicar una parada)';
    return `tramo ${i + 1}, ${s.name} → ${next.name}, ${how}`;
  });
  return `Mapa de la ruta: ${located} de ${stops.length} paradas en el mapa; ${legs.join('; ')}.`;
}

/**
 * Mapa de la ruta (Fase 7.6, M-Q6; maqueta 7.6): paradas numeradas, trazas y líneas rectas. En modo de dibujo, un
 * clic agrega un punto antes de la parada de llegada y un punto se arrastra para moverlo; los extremos quedan fijos
 * en las paradas. La lista de paradas sigue siendo el control principal.
 */
export function RouteMap({
  stops,
  paths,
  drawing,
  onDraw,
}: {
  stops: MapStop[];
  paths: (LngLat[] | null)[];
  drawing: Drawing | null;
  onDraw: (points: LngLat[]) => void;
}) {
  const live = useRef({ stops, paths, drawing, onDraw });
  live.current = { stops, paths, drawing, onDraw };
  const api = useRef<{ map: MlMap; theme: MapTheme; refresh: () => void } | null>(null);

  useEffect(() => {
    api.current?.refresh();
  }, [stops, paths, drawing]);

  const fitAll = (map: MlMap, animate: boolean) => {
    const pts = live.current.stops.map(at).filter((p): p is LngLat => p !== null);
    for (const p of live.current.paths) if (p) pts.push(...p);
    if (pts.length === 0) return;
    const lngs = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 56, maxZoom: 12, animate },
    );
  };

  return (
    <YeboMap
      label={routeMapLabel(stops, paths, drawing)}
      onReady={({ map, theme }) => {
        const c = MAP_COLORS[theme];
        const data = () => {
          const { stops: st, paths: ps, drawing: dr } = live.current;
          const legs: Feature[] = [];
          st.slice(0, -1).forEach((s, i) => {
            const a = at(s);
            const b = at(st[i + 1]!);
            if (!a || !b) return;
            if (dr?.seg === i) {
              legs.push({
                type: 'Feature',
                properties: { kind: 'draw' },
                geometry: { type: 'LineString', coordinates: [a, ...dr.points, b] },
              });
            } else {
              const path = ps[i];
              legs.push({
                type: 'Feature',
                properties: { kind: path ? 'trace' : 'straight' },
                geometry: { type: 'LineString', coordinates: path ?? [a, b] },
              });
            }
          });
          const points = st.flatMap((s, i) => {
            const p = at(s);
            return p
              ? [
                  {
                    type: 'Feature' as const,
                    properties: { n: String(i + 1), name: s.name },
                    geometry: { type: 'Point' as const, coordinates: p },
                  },
                ]
              : [];
          });
          const handles = (dr?.points ?? []).map((p, i) => ({
            type: 'Feature' as const,
            properties: { i },
            geometry: { type: 'Point' as const, coordinates: p },
          }));
          return { legs: fc(legs), points: fc(points), handles: fc(handles) };
        };
        const d = data();
        map.addSource('yebo-legs', { type: 'geojson', data: d.legs });
        map.addSource('yebo-stops', { type: 'geojson', data: d.points });
        map.addSource('yebo-handles', { type: 'geojson', data: d.handles });
        map.addLayer({
          id: 'yebo-legs-halo',
          type: 'line',
          source: 'yebo-legs',
          filter: ['!=', ['get', 'kind'], 'straight'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': c.halo, 'line-width': 8 },
        });
        map.addLayer({
          id: 'yebo-legs-trace',
          type: 'line',
          source: 'yebo-legs',
          filter: ['==', ['get', 'kind'], 'trace'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': c.trace, 'line-width': 4 },
        });
        map.addLayer({
          id: 'yebo-legs-straight',
          type: 'line',
          source: 'yebo-legs',
          filter: ['==', ['get', 'kind'], 'straight'],
          paint: { 'line-color': c.straight, 'line-width': 3, 'line-dasharray': [3, 2.5] },
        });
        map.addLayer({
          id: 'yebo-legs-draw',
          type: 'line',
          source: 'yebo-legs',
          filter: ['==', ['get', 'kind'], 'draw'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': c.draw, 'line-width': 4 },
        });
        map.addLayer({
          id: 'yebo-handles',
          type: 'circle',
          source: 'yebo-handles',
          paint: {
            'circle-radius': 7,
            'circle-color': c.halo,
            'circle-stroke-color': c.stop,
            'circle-stroke-width': 3,
          },
        });
        map.addLayer({
          id: 'yebo-stops',
          type: 'circle',
          source: 'yebo-stops',
          paint: {
            'circle-radius': 13,
            'circle-color': c.stop,
            'circle-stroke-color': c.halo,
            'circle-stroke-width': 3,
          },
        });
        map.addLayer({
          id: 'yebo-stops-n',
          type: 'symbol',
          source: 'yebo-stops',
          layout: {
            'text-field': ['get', 'n'],
            'text-font': ['Noto Sans Medium'],
            'text-size': 13,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: { 'text-color': c.onStop },
        });
        map.addLayer({
          id: 'yebo-stops-name',
          type: 'symbol',
          source: 'yebo-stops',
          layout: {
            'text-field': ['get', 'name'],
            'text-font': ['Noto Sans Medium'],
            'text-size': 14,
            'text-anchor': 'left',
            'text-offset': [1.4, 0],
            'text-optional': true,
          },
          paint: {
            'text-color': c.stop === '#16c7b2' ? '#f3f6f5' : c.stop,
            'text-halo-color': c.halo,
            'text-halo-width': 2,
          },
        });

        const refresh = () => {
          const n = data();
          (map.getSource('yebo-legs') as GeoJSONSource | undefined)?.setData(n.legs);
          (map.getSource('yebo-stops') as GeoJSONSource | undefined)?.setData(n.points);
          (map.getSource('yebo-handles') as GeoJSONSource | undefined)?.setData(n.handles);
          map.getCanvas().style.cursor = live.current.drawing ? 'crosshair' : '';
        };
        api.current = { map, theme, refresh };
        fitAll(map, false);

        // Dibujo: clic agrega un punto; arrastrar un punto lo mueve.
        let dragging: number | null = null;
        let dragged = false;
        const start = (e: MapMouseEvent | MapTouchEvent) => {
          if (!live.current.drawing) return;
          const hit = map.queryRenderedFeatures(e.point, { layers: ['yebo-handles'] })[0];
          if (!hit) return;
          e.preventDefault();
          dragging = Number(hit.properties.i);
          dragged = false;
          map.getCanvas().style.cursor = 'grabbing';
        };
        const move = (e: MapMouseEvent | MapTouchEvent) => {
          const dr = live.current.drawing;
          if (dragging === null || !dr) {
            if (dr) {
              const over = map.queryRenderedFeatures(e.point, { layers: ['yebo-handles'] }).length > 0;
              map.getCanvas().style.cursor = over ? 'grab' : 'crosshair';
            }
            return;
          }
          dragged = true;
          const pts = dr.points.map((p, i) =>
            i === dragging ? ([round6(e.lngLat.lng), round6(e.lngLat.lat)] as LngLat) : p,
          );
          live.current.onDraw(pts);
        };
        const end = () => {
          if (dragging === null) return;
          dragging = null;
          map.getCanvas().style.cursor = 'crosshair';
        };
        map.on('mousedown', start);
        map.on('touchstart', start);
        map.on('mousemove', move);
        map.on('touchmove', move);
        map.on('mouseup', end);
        map.on('touchend', end);
        map.on('click', (e) => {
          const dr = live.current.drawing;
          if (!dr) return;
          if (dragged) {
            dragged = false;
            return;
          }
          if (map.queryRenderedFeatures(e.point, { layers: ['yebo-handles'] }).length > 0) return;
          if (dr.points.length >= 1998) return;
          live.current.onDraw([...dr.points, [round6(e.lngLat.lng), round6(e.lngLat.lat)]]);
        });
        return () => {
          api.current = null;
        };
      }}
    >
      <button
        type="button"
        aria-label="Ver toda la ruta"
        onClick={() => api.current && fitAll(api.current.map, true)}
        className="absolute top-[106px] right-2.5 grid size-11 place-items-center rounded-[4px] border border-control bg-raised text-ink hover:bg-ink/5"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="size-5"
        >
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
      </button>
    </YeboMap>
  );
}
