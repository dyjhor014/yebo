#!/usr/bin/env bash
# Renderiza todos los bloques Mermaid de docs/ a SVG en docs/diagrams/.
# Requisitos: Node >= 18 y Google Chrome instalados. Sin dependencias npm.
# Mermaid se carga desde jsDelivr (versión fijada en build.mjs), por lo que requiere conexión.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cd "$ROOT"
mapfile -t FILES < <(grep -rl '```mermaid' docs --include='*.md' | sort)
node scripts/render-diagrams/build.mjs . "$TMP/all.html" "${FILES[@]}"
google-chrome --headless=new --disable-gpu --no-sandbox --virtual-time-budget=120000 \
  --dump-dom "file://$TMP/all.html" 2>/dev/null > "$TMP/dom.html" || true  # Chrome headless puede salir con código ≠ 0
EXPECTED=$(cat "${FILES[@]}" | grep -c '^```mermaid' || true)
ERRS=$( (grep -o 'class="err"' "$TMP/dom.html" || true) | wc -l)
if [ "$ERRS" -ne 0 ]; then grep -o 'class="err">[^<]*' "$TMP/dom.html"; echo "❌ $ERRS diagramas con error"; exit 1; fi
RENDERED=$( (grep -o '<textarea class="x"' "$TMP/dom.html" || true) | wc -l)
if [ "$RENDERED" -ne "$EXPECTED" ]; then echo "❌ renderizados $RENDERED de $EXPECTED (¿sin conexión al CDN?)"; exit 1; fi
rm -f docs/diagrams/*.svg
node scripts/render-diagrams/extract.mjs "$TMP/dom.html" docs/diagrams
rm -f docs/diagrams/index.json
for f in docs/diagrams/*.svg; do xmllint --noout "$f"; done
echo "✅ diagramas renderizados sin errores y SVG válidos"
