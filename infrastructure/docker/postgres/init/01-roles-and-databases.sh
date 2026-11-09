#!/bin/sh
# Crea los roles y bases de datos de YEBO (ADR-003; separación de privilegios de ADR-034).
#   yebo_owner    → propietario de las tablas; solo migraciones.
#   yebo_app      → API y worker en contexto de tenant. RLS APLICA (no es propietario, sin BYPASSRLS).
#   yebo_platform → resolver de dominios y health check. SIN BYPASSRLS (ADR-034): solo SELECT sobre tenants y
#                   tenant_domains, concedido por migración.
#   yebo_identity → solo el módulo identity: sesiones y tokens (Fase 3.2a). SIN BYPASSRLS.
#   yebo_backoffice → solo la API del superadmin (Fase 4, F4-Q2): tablas de plataforma con permisos explícitos.
#                   SIN BYPASSRLS.
#   yebo_test_bypass → SOLO desarrollo y CI (si YEBO_TEST_BYPASS_PASSWORD está definida): siembra de datos en las
#                   pruebas. BYPASSRLS, sin acceso a yebo_dev ni a yebo_shadow. Nunca en producción.
# Ningún rol de ejecución hereda privilegios ni tiene pertenencias. Sus permisos sobre tablas los conceden las
# migraciones de forma explícita (lista blanca): no hay privilegios por defecto en las bases de la aplicación.
# Se ejecuta una sola vez, al inicializar el volumen de datos. Para volúmenes existentes: scripts/dev/harden-roles.sh.
set -eu

psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres <<SQL
CREATE ROLE yebo_owner    LOGIN PASSWORD '${YEBO_OWNER_PASSWORD}'    NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE yebo_app      LOGIN PASSWORD '${YEBO_APP_PASSWORD}'      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE yebo_platform LOGIN PASSWORD '${YEBO_PLATFORM_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE yebo_identity LOGIN PASSWORD '${YEBO_IDENTITY_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE yebo_backoffice LOGIN PASSWORD '${YEBO_BACKOFFICE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
SQL

TEST_ROLE=false
if [ -n "${YEBO_TEST_BYPASS_PASSWORD:-}" ]; then
  TEST_ROLE=true
  psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres <<SQL
CREATE ROLE yebo_test_bypass LOGIN PASSWORD '${YEBO_TEST_BYPASS_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT BYPASSRLS;
SQL
fi

# yebo_dev: desarrollo · yebo_test: pruebas de integración · yebo_poc_*: pruebas de concepto de la Fase 2
# yebo_shadow: base auxiliar para que Prisma detecte deriva entre migraciones y esquema (solo yebo_owner)
# yebo_migrations: base que las pruebas vacían para validar las migraciones desde cero y desde el esquema anterior
for db in yebo_dev yebo_test yebo_poc_tenancy yebo_poc_inventory yebo_shadow yebo_migrations; do
  case "$db" in
    yebo_shadow) runtime="" ;;
    yebo_poc_*) runtime="yebo_app" ;;
    *) runtime="yebo_app, yebo_platform, yebo_identity, yebo_backoffice" ;;
  esac
  psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres -c "CREATE DATABASE ${db} OWNER yebo_owner;"
  psql -v ON_ERROR_STOP=1 --username postgres --dbname "${db}" <<SQL
REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${db} TO yebo_owner;
ALTER SCHEMA public OWNER TO yebo_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
  if [ -n "$runtime" ]; then
    psql -v ON_ERROR_STOP=1 --username postgres --dbname "${db}" <<SQL
GRANT CONNECT ON DATABASE ${db} TO ${runtime};
GRANT USAGE ON SCHEMA public TO ${runtime};
SQL
  fi
  case "$db" in
    yebo_poc_*)
      # Las PoC de la Fase 2 (bases solo de pruebas) conservan sus migraciones sin GRANT: yebo_app recibe DML por
      # defecto en ESAS bases. Las bases de la aplicación no tienen privilegios por defecto (ADR-034).
      psql -v ON_ERROR_STOP=1 --username postgres --dbname "${db}" <<SQL
ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yebo_app;
SQL
      ;;
  esac
  if $TEST_ROLE; then
    case "$db" in
      yebo_test | yebo_poc_* | yebo_migrations)
        # Permisos de tabla: test/support/global-setup.ts, tras migrar (nunca en una migración).
        psql -v ON_ERROR_STOP=1 --username postgres --dbname "${db}" <<SQL
GRANT CONNECT ON DATABASE ${db} TO yebo_test_bypass;
GRANT USAGE ON SCHEMA public TO yebo_test_bypass;
SQL
        ;;
    esac
  fi
done
echo "YEBO: roles y bases de datos creados (ADR-034; rol de pruebas: ${TEST_ROLE})"
