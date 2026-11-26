#!/usr/bin/env bash
# Fase 7.6 (F7-Q9, M-Q1): genera el mapa propio de YEBO en un directorio, para servirlo en /mapa/ del mismo origen.
#
#   scripts/maps/build-map.sh --out <dir>             # el Perú (zoom 0–15; cientos de MB)
#   scripts/maps/build-map.sh --out <dir> --fixture   # extracto pequeño de Pucallpa para el E2E (zoom 0–11)
#   scripts/maps/build-map.sh --out <dir> --bbox O,S,E,N [--maxzoom 15]   # una zona (p. ej., para probar)
#
# Qué deja en <dir>:
#   peru.pmtiles                        teselas vectoriales (OpenStreetMap, ODbL), recortadas de un build FIJO de Protomaps
#   fuentes/<fuente>/<rango>.pbf        letras del mapa (Noto Sans, OFL), de un commit FIJO de protomaps/basemaps-assets
#   sprites/v4/{light,dark}[@2x].{json,png}   símbolos del mapa (mismo commit)
#   ATRIBUCION.txt y version.json       origen, fechas y SHA-256 de lo generado
#
# Todo va fijado (versión, fecha y huella): dos corridas con los mismos parámetros dan los mismos archivos de origen.
# Nada de esto va en git salvo el extracto pequeño del E2E (M-Q3). Requiere curl, tar y sha256sum (Linux x86_64 o arm64).
set -euo pipefail

PMTILES_VERSION=1.31.2
declare -A PMTILES_SHA256=(
  [x86_64]=3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f
  [aarch64]=f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1
)
# Build diario de Protomaps (planeta, esquema 4.x). Cambiarlo es actualizar el mapa: anótalo en docs/development/mapa.md.
BUILD_DATE=20261124
ASSETS_COMMIT=028c18f713baecad011301ff7a69acc39bcc2ae7
FONTS=('Noto Sans Regular' 'Noto Sans Medium' 'Noto Sans Italic')
# Rangos Unicode para el español y los nombres del Perú: latín básico y extendido, puntuación y símbolos.
RANGES=(0-255 256-511 512-767 7680-7935 8192-8447)

OUT=''
FIXTURE=0
ZONE_BBOX=''
ZONE_MAXZOOM=15
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --fixture) FIXTURE=1; shift ;;
    --bbox) ZONE_BBOX="$2"; shift 2 ;;
    --bbox=*) ZONE_BBOX="${1#*=}"; shift ;;
    --maxzoom) ZONE_MAXZOOM="$2"; shift 2 ;;
    --maxzoom=*) ZONE_MAXZOOM="${1#*=}"; shift ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$OUT" ]] || { echo 'Falta --out <dir>' >&2; exit 2; }

if [[ $FIXTURE -eq 1 ]]; then
  BBOX='-74.75,-8.55,-74.35,-8.25' # Pucallpa y alrededores
  MAXZOOM=11
  RANGES=(0-255)
elif [[ -n "$ZONE_BBOX" ]]; then
  [[ "$ZONE_BBOX" =~ ^-?[0-9.]+,-?[0-9.]+,-?[0-9.]+,-?[0-9.]+$ ]] || { echo 'bbox: oeste,sur,este,norte' >&2; exit 2; }
  [[ "$ZONE_MAXZOOM" =~ ^[0-9]+$ ]] && (( ZONE_MAXZOOM <= 15 )) || { echo 'maxzoom: de 0 a 15' >&2; exit 2; }
  BBOX="$ZONE_BBOX"
  MAXZOOM="$ZONE_MAXZOOM"
else
  BBOX='-81.41,-18.36,-68.65,-0.03' # el Perú
  MAXZOOM=15
fi

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

arch="$(uname -m)"
[[ -n "${PMTILES_SHA256[$arch]:-}" ]] || { echo "Arquitectura no soportada: $arch" >&2; exit 1; }
asset_arch=$([[ $arch == aarch64 ]] && echo arm64 || echo x86_64)
tarball="go-pmtiles_${PMTILES_VERSION}_Linux_${asset_arch}.tar.gz"

echo "→ go-pmtiles v${PMTILES_VERSION} (${asset_arch})"
curl -fsSL -o "$WORK/$tarball" \
  "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${tarball}"
echo "${PMTILES_SHA256[$arch]}  $WORK/$tarball" | sha256sum -c --quiet -
tar -xzf "$WORK/$tarball" -C "$WORK" pmtiles

echo "→ Recorte ${BBOX} (zoom 0–${MAXZOOM}) del build ${BUILD_DATE} de Protomaps"
"$WORK/pmtiles" extract "https://build.protomaps.com/${BUILD_DATE}.pmtiles" "$WORK/peru.pmtiles" \
  --bbox="$BBOX" --maxzoom="$MAXZOOM"
mv "$WORK/peru.pmtiles" "$OUT/peru.pmtiles"

ASSETS="https://raw.githubusercontent.com/protomaps/basemaps-assets/${ASSETS_COMMIT}"
echo "→ Fuentes y sprites (basemaps-assets ${ASSETS_COMMIT:0:7})"
for font in "${FONTS[@]}"; do
  mkdir -p "$OUT/fuentes/$font"
  for range in "${RANGES[@]}"; do
    curl -fsSL -o "$OUT/fuentes/$font/$range.pbf" "$ASSETS/fonts/${font// /%20}/$range.pbf"
  done
done
mkdir -p "$OUT/sprites/v4"
for flavor in light dark; do
  for suffix in '' '@2x'; do
    for ext in json png; do
      curl -fsSL -o "$OUT/sprites/v4/${flavor}${suffix}.${ext}" "$ASSETS/sprites/v4/${flavor}${suffix}.${ext}"
    done
  done
done
curl -fsSL -o "$OUT/fuentes/OFL.txt" "$ASSETS/fonts/OFL.txt"

cat > "$OUT/ATRIBUCION.txt" <<EOF
Datos del mapa: © colaboradores de OpenStreetMap, disponibles bajo la Open Database License (ODbL)
https://www.openstreetmap.org/copyright
Teselas: build ${BUILD_DATE} de Protomaps (https://protomaps.com), recortado con go-pmtiles v${PMTILES_VERSION}.
Fuentes: Noto Sans (SIL Open Font License, ver fuentes/OFL.txt). Sprites: protomaps/basemaps-assets ${ASSETS_COMMIT}.
EOF

sha="$(sha256sum "$OUT/peru.pmtiles" | cut -d' ' -f1)"
size="$(stat -c %s "$OUT/peru.pmtiles")"
cat > "$OUT/version.json" <<EOF
{
  "build": "${BUILD_DATE}",
  "bbox": "${BBOX}",
  "maxzoom": ${MAXZOOM},
  "pmtiles": "${PMTILES_VERSION}",
  "assets": "${ASSETS_COMMIT}",
  "sha256": "${sha}",
  "bytes": ${size}
}
EOF
echo "✓ ${OUT}/peru.pmtiles · $((size / 1024 / 1024)) MB · sha256 ${sha}"
