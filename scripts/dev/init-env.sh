#!/usr/bin/env bash
# Genera los archivos .env de desarrollo con contraseñas aleatorias.
# No sobrescribe archivos existentes (usa --force para regenerarlos; requiere recrear los volúmenes de Docker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INFRA_ENV="$ROOT/infrastructure/docker/.env"
API_ENV="$ROOT/apps/api/.env"
# Credenciales del rol de PRUEBAS yebo_test_bypass (ADR-034). Solo las carga test/support; la API no las conoce.
TEST_ENV="$ROOT/apps/api/.env.test"
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

# Rol de pruebas (ADR-034): contraseña en infrastructure/docker/.env (init del contenedor y harden-roles.sh) y en
# apps/api/.env.test (pruebas). En un volumen existente, el rol se crea con scripts/dev/harden-roles.sh --test-role.
write_test_env() {
  umask 077
  printf '# Rol EXCLUSIVO de pruebas (ADR-034): BYPASSRLS, solo en bases de prueba. Nunca en la API ni en producción.\nTEST_PG_BYPASS_USER=yebo_test_bypass\nTEST_PG_BYPASS_PASSWORD=%s\n' "$1" > "$TEST_ENV"
}

add_missing_adr034() {
  if [[ -f "$INFRA_ENV" ]] && ! grep -q '^TEST_PG_BYPASS_PASSWORD=' "$INFRA_ENV"; then
    local pass
    pass=$(openssl rand -hex 24)
    printf 'TEST_PG_BYPASS_PASSWORD=%s\n' "$pass" >> "$INFRA_ENV"
    write_test_env "$pass"
    echo "Añadida TEST_PG_BYPASS_PASSWORD. En un volumen existente: scripts/dev/harden-roles.sh --test-role"
  elif [[ -f "$INFRA_ENV" && ! -f "$TEST_ENV" ]]; then
    write_test_env "$(grep '^TEST_PG_BYPASS_PASSWORD=' "$INFRA_ENV" | cut -d= -f2-)"
    echo "Generado apps/api/.env.test."
  fi
}

# Fase 4.1: rol yebo_backoffice (F4-Q2) y clave de cifrado de campo (ADR-019).
add_missing_phase41() {
  if [[ -f "$INFRA_ENV" ]] && ! grep -q '^PG_BACKOFFICE_PASSWORD=' "$INFRA_ENV"; then
    local pass
    pass=$(openssl rand -hex 24)
    printf 'PG_BACKOFFICE_PASSWORD=%s\n' "$pass" >> "$INFRA_ENV"
    if [[ -f "$API_ENV" ]] && ! grep -q '^PG_BACKOFFICE_PASSWORD=' "$API_ENV"; then
      printf '\n# Rol del superadmin (añadido por init-env.sh)\nPG_BACKOFFICE_USER=yebo_backoffice\nPG_BACKOFFICE_PASSWORD=%s\n' "$pass" >> "$API_ENV"
    fi
    echo "Añadida PG_BACKOFFICE_PASSWORD. En un volumen existente: scripts/dev/harden-roles.sh --test-role"
  fi
  if [[ -f "$API_ENV" ]] && ! grep -q '^FIELD_ENCRYPTION_KEY=' "$API_ENV"; then
    printf 'FIELD_ENCRYPTION_KEY=%s\nFIELD_ENCRYPTION_KEY_VERSION=1\n' "$(openssl rand -base64 32)" >> "$API_ENV"
    echo "Añadida FIELD_ENCRYPTION_KEY a apps/api/.env."
  fi
}

# Fase 4.4: rol yebo_metering (F4-Q2), jobs de medición.
add_missing_phase44() {
  if [[ -f "$INFRA_ENV" ]] && ! grep -q '^PG_METERING_PASSWORD=' "$INFRA_ENV"; then
    local pass
    pass=$(openssl rand -hex 24)
    printf 'PG_METERING_PASSWORD=%s\n' "$pass" >> "$INFRA_ENV"
    if [[ -f "$API_ENV" ]] && ! grep -q '^PG_METERING_PASSWORD=' "$API_ENV"; then
      printf '\n# Rol de la medición (añadido por init-env.sh)\nPG_METERING_USER=yebo_metering\nPG_METERING_PASSWORD=%s\n' "$pass" >> "$API_ENV"
    fi
    echo "Añadida PG_METERING_PASSWORD. En un volumen existente: scripts/dev/harden-roles.sh --test-role"
  fi
}

# Fase 5.2: almacenamiento S3 (Garage) de desarrollo. La clave S3 de Garage: id «GK» + 24 hex, secreto de 64 hex.
add_missing_phase52() {
  if [[ -f "$INFRA_ENV" ]] && ! grep -q '^GARAGE_RPC_SECRET=' "$INFRA_ENV"; then
    local key secret
    key="GK$(openssl rand -hex 12)"
    secret=$(openssl rand -hex 32)
    printf 'GARAGE_RPC_SECRET=%s\nS3_ACCESS_KEY_ID=%s\nS3_SECRET_ACCESS_KEY=%s\nS3_BUCKET=yebo-assets\n' \
      "$(openssl rand -hex 32)" "$key" "$secret" >> "$INFRA_ENV"
    if [[ -f "$API_ENV" ]] && ! grep -q '^S3_ACCESS_KEY_ID=' "$API_ENV"; then
      printf '\n# Almacenamiento S3 (Garage; añadido por init-env.sh)\nS3_ENDPOINT=http://127.0.0.1:3900\nS3_REGION=garage\nS3_BUCKET=yebo-assets\nS3_ACCESS_KEY_ID=%s\nS3_SECRET_ACCESS_KEY=%s\n' \
        "$key" "$secret" >> "$API_ENV"
    fi
    echo "Añadidas las credenciales del almacenamiento S3 (Garage). Arráncalo con: pnpm infra:up"
  fi
}

if [[ -f "$INFRA_ENV" && "$FORCE" != "--force" ]]; then
  add_missing_phase32
  add_missing_adr034
  add_missing_phase41
  add_missing_phase44
  add_missing_phase52
  echo "Ya existe $INFRA_ENV (usa --force para regenerar)."; exit 0
fi

rnd() { openssl rand -hex 24; }
PG_SUPERUSER_PASSWORD=$(rnd); PG_OWNER_PASSWORD=$(rnd); PG_APP_PASSWORD=$(rnd); PG_PLATFORM_PASSWORD=$(rnd); REDIS_PASSWORD=$(rnd)
PG_IDENTITY_PASSWORD=$(rnd)
TEST_PG_BYPASS_PASSWORD=$(rnd)
PG_BACKOFFICE_PASSWORD=$(rnd)
PG_METERING_PASSWORD=$(rnd)
GARAGE_RPC_SECRET=$(openssl rand -hex 32)
S3_ACCESS_KEY_ID="GK$(openssl rand -hex 12)"
S3_SECRET_ACCESS_KEY=$(openssl rand -hex 32)

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
TEST_PG_BYPASS_PASSWORD=$TEST_PG_BYPASS_PASSWORD
PG_BACKOFFICE_PASSWORD=$PG_BACKOFFICE_PASSWORD
PG_METERING_PASSWORD=$PG_METERING_PASSWORD
GARAGE_RPC_SECRET=$GARAGE_RPC_SECRET
S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
S3_BUCKET=yebo-assets
ENV
write_test_env "$TEST_PG_BYPASS_PASSWORD"

sed -e "s|^PG_OWNER_PASSWORD=.*|PG_OWNER_PASSWORD=$PG_OWNER_PASSWORD|" \
    -e "s|^PG_APP_PASSWORD=.*|PG_APP_PASSWORD=$PG_APP_PASSWORD|" \
    -e "s|^PG_PLATFORM_PASSWORD=.*|PG_PLATFORM_PASSWORD=$PG_PLATFORM_PASSWORD|" \
    -e "s|^PG_IDENTITY_PASSWORD=.*|PG_IDENTITY_PASSWORD=$PG_IDENTITY_PASSWORD|" \
    -e "s|^PG_BACKOFFICE_PASSWORD=.*|PG_BACKOFFICE_PASSWORD=$PG_BACKOFFICE_PASSWORD|" \
    -e "s|^PG_METERING_PASSWORD=.*|PG_METERING_PASSWORD=$PG_METERING_PASSWORD|" \
    -e "s|^FIELD_ENCRYPTION_KEY=.*|FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)|" \
    -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$REDIS_PASSWORD|" \
    -e "s|^S3_ACCESS_KEY_ID=.*|S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID|" \
    -e "s|^S3_SECRET_ACCESS_KEY=.*|S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY|" \
    -e "s|^AUTH_JWT_PRIVATE_KEY=.*|AUTH_JWT_PRIVATE_KEY=$(auth_key)|" \
    -e "s|^AUTH_COOKIE_SECRET=.*|AUTH_COOKIE_SECRET=$(openssl rand -hex 32)|" \
    "$ROOT/apps/api/.env.example" > "$API_ENV"

echo "Generados: infrastructure/docker/.env, apps/api/.env y apps/api/.env.test (permisos 600)."
