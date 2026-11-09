#!/usr/bin/env bash
# =====================================================================================================
# ADR-034 · Parte A (nivel de CLÚSTER) para volúmenes EXISTENTES de desarrollo. Los volúmenes nuevos y CI ya
# nacen así (infrastructure/docker/postgres/init/01-roles-and-databases.sh). En producción, lo mismo SIN
# --test-role irá en el aprovisionamiento (Fase 15). La parte B (tablas) es la migración
# 20261110130000_adr034_privilege_separation.
#
# Requiere SUPERUSUARIO (ALTER ROLE … BYPASSRLS no lo puede hacer yebo_owner). Idempotente.
#
#   A1  Atributos: ningún rol de ejecución salta RLS ni hereda privilegios.
#   A2  Sin pertenencias: revoca cualquier pertenencia de los roles yebo_* (también a roles predefinidos).
#   A3  Conexión: cada rol de ejecución solo a las bases que usa (solo si esas bases existen).
#   A4  (--test-role) Rol yebo_test_bypass, SOLO en clústeres de desarrollo y CI.
#
# Uso:
#   scripts/dev/harden-roles.sh               # A1–A3
#   scripts/dev/harden-roles.sh --test-role   # A1–A4 (desarrollo y CI)
# Destino alternativo (p. ej., un contenedor desechable): YEBO_PG_CONTAINER=<nombre> scripts/dev/harden-roles.sh
# Reversión: docs/development/phase-3-plan.md, "ADR-034 · reversión".
# =====================================================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INFRA_ENV="$ROOT/infrastructure/docker/.env"
WITH_TEST_ROLE=false
[[ "${1:-}" == "--test-role" ]] && WITH_TEST_ROLE=true

if [[ -n "${YEBO_PG_CONTAINER:-}" ]]; then
  PSQL=(docker exec -i "$YEBO_PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -X -q)
else
  PSQL=(docker compose --env-file "$INFRA_ENV" -f "$ROOT/infrastructure/docker/compose.dev.yaml"
        exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -X -q)
fi

# ---------------------------------------------------------------------------------------------------
# A0. Roles por función de la Fase 4 (F4-Q2) que un volumen anterior no tiene. Contraseña de infrastructure/docker/.env.
# ---------------------------------------------------------------------------------------------------
BACKOFFICE_PASS="${PG_BACKOFFICE_PASSWORD:-$(grep '^PG_BACKOFFICE_PASSWORD=' "$INFRA_ENV" 2>/dev/null | cut -d= -f2- || true)}"
if [[ -z "$BACKOFFICE_PASS" ]]; then
  echo "Falta PG_BACKOFFICE_PASSWORD (infrastructure/docker/.env o entorno): ejecuta scripts/dev/init-env.sh" >&2; exit 1
fi
"${PSQL[@]}" -d postgres -v pass="$BACKOFFICE_PASS" <<'SQL'
SELECT format('CREATE ROLE yebo_backoffice LOGIN PASSWORD %L', :'pass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yebo_backoffice') \gexec
SELECT format('ALTER ROLE yebo_backoffice PASSWORD %L', :'pass') \gexec
SQL
for db in yebo_dev yebo_test yebo_migrations; do
  if "${PSQL[@]}" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    "${PSQL[@]}" -d "$db" -c "GRANT CONNECT ON DATABASE $db TO yebo_backoffice; GRANT USAGE ON SCHEMA public TO yebo_backoffice;"
  fi
done

# ---------------------------------------------------------------------------------------------------
# A1–A3 en UNA transacción: o se aplica todo o nada (los cambios de roles son transaccionales).
# ---------------------------------------------------------------------------------------------------
"${PSQL[@]}" -d postgres <<'SQL'
BEGIN;

-- A1. Atributos. (yebo_owner conserva CREATEDB si lo tuviera; hoy no lo tiene.)
ALTER ROLE yebo_platform NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE yebo_app      NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE yebo_identity NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE yebo_backoffice NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE yebo_owner    NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEROLE NOREPLICATION;

-- A2. Ninguna pertenencia (ni a otros roles yebo_*, ni a pg_read_all_data, pg_write_all_data, etc.).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT g.rolname AS grp, m.rolname AS mem
             FROM pg_auth_members am
             JOIN pg_roles g ON g.oid = am.roleid
             JOIN pg_roles m ON m.oid = am.member
            WHERE m.rolname IN ('yebo_app', 'yebo_platform', 'yebo_identity', 'yebo_backoffice', 'yebo_owner')
  LOOP
    RAISE NOTICE 'Revocando pertenencia: % ∈ %', r.mem, r.grp;
    EXECUTE format('REVOKE %I FROM %I', r.grp, r.mem);
  END LOOP;
END $$;

-- A3. Conexión por base (igual que el init). Solo se tocan las bases que existen (en producción no hay shadow ni PoC).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'yebo_shadow') THEN
    -- La base auxiliar de Prisma solo la usa yebo_owner.
    REVOKE CONNECT ON DATABASE yebo_shadow FROM yebo_app, yebo_platform, yebo_identity, yebo_backoffice;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'yebo_poc_tenancy') THEN
    REVOKE CONNECT ON DATABASE yebo_poc_tenancy FROM yebo_platform, yebo_identity, yebo_backoffice;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'yebo_poc_inventory') THEN
    REVOKE CONNECT ON DATABASE yebo_poc_inventory FROM yebo_platform, yebo_identity, yebo_backoffice;
  END IF;
END $$;

COMMIT;
SQL

# ---------------------------------------------------------------------------------------------------
# A4. Rol de pruebas (solo con --test-role). Nunca en producción.
# ---------------------------------------------------------------------------------------------------
if $WITH_TEST_ROLE; then
  TEST_PASS="${TEST_PG_BYPASS_PASSWORD:-$(grep '^TEST_PG_BYPASS_PASSWORD=' "$INFRA_ENV" 2>/dev/null | cut -d= -f2- || true)}"
  if [[ -z "$TEST_PASS" ]]; then
    echo "Falta TEST_PG_BYPASS_PASSWORD (infrastructure/docker/.env o entorno)." >&2; exit 1
  fi
  "${PSQL[@]}" -d postgres -v pass="$TEST_PASS" <<'SQL'
BEGIN;
SELECT format('CREATE ROLE yebo_test_bypass LOGIN PASSWORD %L', :'pass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yebo_test_bypass') \gexec
SELECT format('ALTER ROLE yebo_test_bypass PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT BYPASSRLS', :'pass') \gexec

-- Sin acceso a desarrollo compartido ni a la base auxiliar de Prisma (explícito aunque PUBLIC ya no tiene CONNECT).
DO $$
DECLARE db text;
BEGIN
  FOREACH db IN ARRAY ARRAY['yebo_dev', 'yebo_shadow'] LOOP
    IF EXISTS (SELECT 1 FROM pg_database WHERE datname = db) THEN
      EXECUTE format('REVOKE ALL ON DATABASE %I FROM yebo_test_bypass', db);
    END IF;
  END LOOP;
  FOREACH db IN ARRAY ARRAY['yebo_test', 'yebo_poc_tenancy', 'yebo_poc_inventory', 'yebo_migrations'] LOOP
    IF EXISTS (SELECT 1 FROM pg_database WHERE datname = db) THEN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO yebo_test_bypass', db);
    END IF;
  END LOOP;
END $$;
COMMIT;
SQL
  # USAGE del esquema en cada base de prueba (el GRANT de tablas lo hace test/support/global-setup).
  for db in yebo_test yebo_poc_tenancy yebo_poc_inventory yebo_migrations; do
    if "${PSQL[@]}" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
      "${PSQL[@]}" -d "$db" -c "GRANT USAGE ON SCHEMA public TO yebo_test_bypass;"
    fi
  done
fi

# ---------------------------------------------------------------------------------------------------
# Comprobación final: atributos y pertenencias resultantes.
# ---------------------------------------------------------------------------------------------------
"${PSQL[@]}" -d postgres -At -F' | ' <<'SQL'
SELECT 'rol', rolname, 'bypassrls=' || rolbypassrls, 'inherit=' || rolinherit, 'super=' || rolsuper
  FROM pg_roles WHERE rolname LIKE 'yebo_%' ORDER BY rolname;
SELECT 'pertenencias de yebo_*', count(*)
  FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member WHERE m.rolname LIKE 'yebo_%';
SQL
