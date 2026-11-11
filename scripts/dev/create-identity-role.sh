#!/usr/bin/env bash
# Crea el rol yebo_identity en un volumen de PostgreSQL EXISTENTE (los volúmenes nuevos lo crean en el init).
# Idempotente. Usa la contraseña PG_IDENTITY_PASSWORD de infrastructure/docker/.env (init-env.sh la genera).
# Reversión: ver docs/development/phase-3-plan.md ("Migración 20261109140000 y su reversión").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INFRA_ENV="$ROOT/infrastructure/docker/.env"
COMPOSE=(docker compose --env-file "$INFRA_ENV" -f "$ROOT/infrastructure/docker/compose.dev.yaml")

PASS=$(grep '^PG_IDENTITY_PASSWORD=' "$INFRA_ENV" | cut -d= -f2-)
if [[ -z "$PASS" ]]; then
  echo "Falta PG_IDENTITY_PASSWORD en $INFRA_ENV: ejecuta scripts/dev/init-env.sh" >&2; exit 1
fi

"${COMPOSE[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres -v pass="$PASS" <<'SQL'
SELECT format('CREATE ROLE yebo_identity LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'pass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yebo_identity') \gexec
SELECT format('ALTER ROLE yebo_identity PASSWORD %L', :'pass') \gexec
SQL

for db in yebo_dev yebo_test yebo_poc_tenancy yebo_poc_inventory yebo_shadow yebo_migrations; do
  "${COMPOSE[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d "$db" -c \
    "GRANT CONNECT ON DATABASE ${db} TO yebo_identity; GRANT USAGE ON SCHEMA public TO yebo_identity;"
done
echo "Rol yebo_identity listo. Aplica las migraciones: pnpm --filter @yebo/api db:migrate:deploy"
