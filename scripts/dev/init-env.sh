#!/usr/bin/env bash
# Genera los archivos .env de desarrollo con contraseñas aleatorias.
# No sobrescribe archivos existentes (usa --force para regenerarlos; requiere recrear los volúmenes de Docker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INFRA_ENV="$ROOT/infrastructure/docker/.env"
API_ENV="$ROOT/apps/api/.env"
FORCE="${1:-}"

# Clave Ed25519 de los access tokens (EdDSA, security.md §1): PEM PKCS#8 en base64, en una sola línea.
auth_key() { openssl genpkey -algorithm ed25519 2>/dev/null | base64 | tr -d '\n'; }

# Añade a archivos .env existentes las variables de la Fase 3.2 que falten, sin tocar las demás.
# La contraseña de yebo_identity se escribe en los dos archivos; el rol se crea con scripts/dev/create-identity-role.sh.
add_missing_phase32() {
  if [[ -f "$API_ENV" ]] && ! grep -q '^AUTH_JWT_PRIVATE_KEY=' "$API_ENV"; then
    printf '\n# Autenticación (añadido por init-env.sh)\nAUTH_JWT_PRIVATE_KEY=%s\nAUTH_JWT_KEY_ID=k1\n' "$(auth_key)" >> "$API_ENV"
    echo "Añadida AUTH_JWT_PRIVATE_KEY a apps/api/.env."
  fi
  if [[ -f "$API_ENV" ]] && ! grep -q '^AUTH_COOKIE_SECRET=' "$API_ENV"; then
    printf 'AUTH_COOKIE_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$API_ENV"
    echo "Añadida AUTH_COOKIE_SECRET a apps/api/.env."
  fi
  if [[ -f "$INFRA_ENV" ]] && ! grep -q '^PG_IDENTITY_PASSWORD=' "$INFRA_ENV"; then
    local pass
    pass=$(openssl rand -hex 24)
    printf 'PG_IDENTITY_PASSWORD=%s\n' "$pass" >> "$INFRA_ENV"
    if [[ -f "$API_ENV" ]] && ! grep -q '^PG_IDENTITY_PASSWORD=' "$API_ENV"; then
      printf '\n# Rol de identidad (añadido por init-env.sh)\nPG_IDENTITY_USER=yebo_identity\nPG_IDENTITY_PASSWORD=%s\n' "$pass" >> "$API_ENV"
    fi
    echo "Añadida PG_IDENTITY_PASSWORD. En un volumen existente, crea el rol: scripts/dev/create-identity-role.sh"
  fi
}

if [[ -f "$INFRA_ENV" && "$FORCE" != "--force" ]]; then
  add_missing_phase32
  echo "Ya existe $INFRA_ENV (usa --force para regenerar)."; exit 0
fi

rnd() { openssl rand -hex 24; }
PG_SUPERUSER_PASSWORD=$(rnd); PG_OWNER_PASSWORD=$(rnd); PG_APP_PASSWORD=$(rnd); PG_PLATFORM_PASSWORD=$(rnd); REDIS_PASSWORD=$(rnd)
PG_IDENTITY_PASSWORD=$(rnd)

umask 077
cat > "$INFRA_ENV" <<ENV
PG_PORT=5433
REDIS_PORT=6380
PG_SUPERUSER_PASSWORD=$PG_SUPERUSER_PASSWORD
PG_OWNER_PASSWORD=$PG_OWNER_PASSWORD
PG_APP_PASSWORD=$PG_APP_PASSWORD
PG_PLATFORM_PASSWORD=$PG_PLATFORM_PASSWORD
PG_IDENTITY_PASSWORD=$PG_IDENTITY_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD
ENV

sed -e "s|^PG_OWNER_PASSWORD=.*|PG_OWNER_PASSWORD=$PG_OWNER_PASSWORD|" \
    -e "s|^PG_APP_PASSWORD=.*|PG_APP_PASSWORD=$PG_APP_PASSWORD|" \
    -e "s|^PG_PLATFORM_PASSWORD=.*|PG_PLATFORM_PASSWORD=$PG_PLATFORM_PASSWORD|" \
    -e "s|^PG_IDENTITY_PASSWORD=.*|PG_IDENTITY_PASSWORD=$PG_IDENTITY_PASSWORD|" \
    -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$REDIS_PASSWORD|" \
    -e "s|^AUTH_JWT_PRIVATE_KEY=.*|AUTH_JWT_PRIVATE_KEY=$(auth_key)|" \
    -e "s|^AUTH_COOKIE_SECRET=.*|AUTH_COOKIE_SECRET=$(openssl rand -hex 32)|" \
    "$ROOT/apps/api/.env.example" > "$API_ENV"

echo "Generados: infrastructure/docker/.env y apps/api/.env (permisos 600)."
