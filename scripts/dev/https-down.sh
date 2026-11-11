#!/usr/bin/env bash
# Detiene el modo HTTPS local: Nginx (Docker) y los procesos arrancados por https-up.sh.
set -euo pipefail
source "$(dirname "$0")/https-common.sh"
cd "$ROOT"
docker compose --env-file infrastructure/docker/.env -f infrastructure/docker/compose.dev.yaml --profile https stop https >/dev/null 2>&1 || true
docker compose --env-file infrastructure/docker/.env -f infrastructure/docker/compose.dev.yaml --profile https rm -f https >/dev/null 2>&1 || true
shopt -s nullglob
for pidfile in "$RUN_DIR"/*.pid; do
  pid=$(cat "$pidfile")
  # Solo procesos que siguen vivos; `next start` lanza hijos, así que se detiene el grupo del proceso.
  if kill -0 "$pid" 2>/dev/null; then
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
done
echo "Modo HTTPS detenido."
