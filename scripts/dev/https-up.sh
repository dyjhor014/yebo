#!/usr/bin/env bash
# Levanta YEBO en HTTPS local para probar desde la red (docs/development/https-local.md):
#   - compila contratos, API, web y panel;
#   - arranca API, worker, web (3100) y panel (3101) en 127.0.0.1, en modo producción, con los hosts
#     <nombre>.<ip>.sslip.io (variables de entorno: apps/api/.env NO se modifica);
#   - arranca Nginx (Docker, perfil https) en <ip>:443 con el certificado de https-certs.sh.
# Requiere `pnpm infra:up` (PostgreSQL y Redis). Base de datos: la de apps/api/.env (yebo_dev) salvo PG_DATABASE.
set -euo pipefail
source "$(dirname "$0")/https-common.sh"
cd "$ROOT"
source ~/.nvm/nvm.sh >/dev/null 2>&1 && nvm use >/dev/null 2>&1 || true

if [[ -d "$RUN_DIR" ]] && compgen -G "$RUN_DIR/*.pid" >/dev/null; then
  echo "Ya hay procesos del modo HTTPS ($RUN_DIR). Ejecuta primero: pnpm https:down" >&2
  exit 1
fi
for port in 4100 4101 3100 3101; do
  if ss -ltn "sport = :$port" | grep -q LISTEN; then
    echo "El puerto $port está ocupado. Detén lo que lo usa (o pnpm https:down) y vuelve a intentarlo." >&2
    exit 1
  fi
done
if ss -ltn "sport = :443" | grep -q LISTEN; then
  echo "El puerto 443 está ocupado; Nginx no podría escuchar en $YEBO_HTTPS_IP:443." >&2
  exit 1
fi

bash "$ROOT/scripts/dev/https-certs.sh" >/dev/null
echo "Compilando (contratos, API, web y panel)…"
pnpm turbo run build --filter=@yebo/api --filter=@yebo/web --filter=@yebo/platform --output-logs=errors-only >/dev/null

export TENANT_BASE_DOMAIN="$YEBO_BASE_DOMAIN"
export AUTH_HUB_HOST="cuentas.$YEBO_BASE_DOMAIN"
export PLATFORM_ADMIN_HOST="admin.$YEBO_BASE_DOMAIN"
export TRUST_PROXY=loopback
export API_HOST=127.0.0.1
export WORKER_HEALTH_HOST=127.0.0.1
export API_INTERNAL_URL=http://127.0.0.1:4100
export NODE_ENV=production
export LOG_PRETTY=false

mkdir -p "$RUN_DIR"
start() { # nombre, carpeta, comando...
  local name=$1 dir=$2
  shift 2
  # `cd` va aparte: con `cd && cmd &` el & se aplicaría a toda la lista y $! no sería el PID de la app.
  (
    cd "$ROOT/$dir" || exit 1
    nohup "$@" >"$RUN_DIR/$name.log" 2>&1 &
    echo $! >"$RUN_DIR/$name.pid"
  )
}
start api apps/api node dist/main.js
start worker apps/api node dist/worker.js
start web apps/web ./node_modules/.bin/next start --hostname 127.0.0.1 --port 3100
start platform apps/platform ./node_modules/.bin/next start --hostname 127.0.0.1 --port 3101

wait_for() { # nombre, url
  for _ in $(seq 1 60); do
    curl -fs -o /dev/null "$2" && return 0
    sleep 0.5
  done
  echo "No arrancó $1; revisa $RUN_DIR/$1.log" >&2
  bash "$ROOT/scripts/dev/https-down.sh" >/dev/null || true
  exit 1
}
wait_for api http://127.0.0.1:4100/api/v1/health/live
wait_for worker http://127.0.0.1:4101/api/v1/health/live
wait_for web http://127.0.0.1:3100/
wait_for platform http://127.0.0.1:3101/login

export YEBO_BASE_DOMAIN_RE="${YEBO_BASE_DOMAIN//./\\.}"
docker compose --env-file infrastructure/docker/.env -f infrastructure/docker/compose.dev.yaml --profile https up -d --wait https >/dev/null
if ! curl -fs -o /dev/null --cacert "$CERT_DIR/yebo-dev-ca.crt" "https://admin.$YEBO_BASE_DOMAIN/login"; then
  echo "Nginx no responde en https://admin.$YEBO_BASE_DOMAIN; revisa: docker logs yebo-dev-https-1" >&2
  exit 1
fi

cat <<MSG
YEBO en HTTPS local (IP $YEBO_HTTPS_IP):
  Panel del staff:  https://admin.$YEBO_BASE_DOMAIN
  Cuentas YEBO:     https://cuentas.$YEBO_BASE_DOMAIN
  Empresas:         https://<subdominio>.$YEBO_BASE_DOMAIN
CA que hay que instalar en cada navegador de prueba: $CERT_DIR/yebo-dev-ca.crt
Registros: $RUN_DIR/*.log   ·   Detener: pnpm https:down
MSG
