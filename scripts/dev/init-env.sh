#!/usr/bin/env bash
# Genera los archivos .env de desarrollo con contraseñas aleatorias.
# No sobrescribe archivos existentes (usa --force para regenerarlos; requiere recrear los volúmenes de Docker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INFRA_ENV="$ROOT/infrastructure/docker/.env"
API_ENV="$ROOT/apps/api/.env"
FORCE="${1:-}"

if [[ -f "$INFRA_ENV" && "$FORCE" != "--force" ]]; then
  echo "Ya existe $INFRA_ENV (usa --force para regenerar)."; exit 0
fi

rnd() { openssl rand -hex 24; }
PG_SUPERUSER_PASSWORD=$(rnd); PG_OWNER_PASSWORD=$(rnd); PG_APP_PASSWORD=$(rnd); PG_PLATFORM_PASSWORD=$(rnd); REDIS_PASSWORD=$(rnd)

umask 077
cat > "$INFRA_ENV" <<ENV
PG_PORT=5433
REDIS_PORT=6380
PG_SUPERUSER_PASSWORD=$PG_SUPERUSER_PASSWORD
PG_OWNER_PASSWORD=$PG_OWNER_PASSWORD
PG_APP_PASSWORD=$PG_APP_PASSWORD
PG_PLATFORM_PASSWORD=$PG_PLATFORM_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD
ENV

sed -e "s|^PG_OWNER_PASSWORD=.*|PG_OWNER_PASSWORD=$PG_OWNER_PASSWORD|" \
    -e "s|^PG_APP_PASSWORD=.*|PG_APP_PASSWORD=$PG_APP_PASSWORD|" \
    -e "s|^PG_PLATFORM_PASSWORD=.*|PG_PLATFORM_PASSWORD=$PG_PLATFORM_PASSWORD|" \
    -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$REDIS_PASSWORD|" \
    "$ROOT/apps/api/.env.example" > "$API_ENV"

echo "Generados: infrastructure/docker/.env y apps/api/.env (permisos 600)."
