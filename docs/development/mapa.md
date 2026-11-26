# Mapa propio (Fase 7.6)

El panel muestra mapas en **Ubicaciones** (elegir la posición) y en **Rutas** (paradas, trazas y dibujo de trazas) con [MapLibre](https://maplibre.org) y teselas propias del Perú. Todo se sirve desde `/mapa/` en el **mismo origen**: el navegador no pide nada a otros dominios (F7-Q9, M-Q1 a M-Q7 en [phase-7-plan.md](phase-7-plan.md)).

## Qué hay en el directorio del mapa

`scripts/maps/build-map.sh` lo genera, con versiones y huellas fijas:

| Archivo | Origen | Licencia |
|---|---|---|
| `peru.pmtiles` | Recorte del Perú (zoom 0–15) de un build con fecha fija de [Protomaps](https://protomaps.com), hecho con `go-pmtiles` (binario verificado con SHA-256) | Datos © colaboradores de OpenStreetMap, **ODbL** |
| `fuentes/<fuente>/<rango>.pbf` | Noto Sans de `protomaps/basemaps-assets` (commit fijo) | SIL OFL |
| `sprites/v4/{light,dark}[@2x].{json,png}` | Mismo commit | Ver el repositorio de origen |
| `ATRIBUCION.txt`, `version.json` | Fecha del build, caja, zoom, commit, SHA-256 y tamaño | — |

```bash
scripts/maps/build-map.sh --out ~/yebo-mapa            # el Perú (cientos de MB; se mide al generarlo)
scripts/maps/build-map.sh --out tests/e2e/fixtures/mapa --fixture   # extracto de Pucallpa del E2E (< 1 MB)
```

**Actualizar el mapa:** cambiar `BUILD_DATE` en el script (Protomaps publica un build por día y conserva los anteriores), generar, revisar `version.json` y anotar aquí la fecha. El archivo del Perú **no va en git**; el extracto del E2E sí (M-Q3), con su `ATRIBUCION.txt`.

## Cómo se sirve

| Entorno | Quién sirve `/mapa/` |
|---|---|
| Desarrollo (`pnpm dev`) y E2E | La ruta de Next `apps/web/app/mapa/[...archivo]/route.ts`, que lee de `YEBO_MAP_DIR` con soporte de `Range` (206/416), solo extensiones permitidas y sin salir del directorio (`lib/map-files.ts`, con pruebas) |
| Producción | **Nginx**, con el mismo camino (abajo). Next ni siquiera recibe la petición |

```nginx
location /mapa/ {
    alias /srv/yebo-mapa/;            # el directorio generado por el script
    add_header Cache-Control "public, max-age=86400";
    add_header Cross-Origin-Resource-Policy same-origin;
    add_header X-Content-Type-Options nosniff;
    types { application/vnd.pmtiles pmtiles; application/x-protobuf pbf; application/json json; image/png png; }
    default_type application/octet-stream;
    # Nginx responde rangos (206) de archivos estáticos por sí mismo.
}
```

El *worker* de MapLibre no es parte del mapa: `apps/web/scripts/copy-map-worker.mjs` lo copia a `public/vendor/` al compilar (`pnpm dev` y `pnpm build`), con la versión en el nombre, y la app lo indica con `setWorkerUrl`.

## Sin el mapa

Si `/mapa/peru.pmtiles` no existe, las pantallas lo dicen en una línea («El mapa no está instalado en este servidor…») y todo sigue funcionando con la lista de paradas y los campos de latitud y longitud (M-Q7). Ningún flujo depende del mapa.

## Atribución

Todo mapa muestra «© OpenStreetMap» con el enlace a la página de derechos de OpenStreetMap, como exige la ODbL.
