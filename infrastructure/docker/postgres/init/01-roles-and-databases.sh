#!/bin/sh
# Crea los roles y bases de datos de YEBO (ADR-003).
#   yebo_owner    → propietario de las tablas; solo migraciones.
#   yebo_app      → API y worker en contexto de tenant. RLS APLICA (no es propietario, sin BYPASSRLS).
#   yebo_platform → resolver de dominios, identidad, superadmin y jobs entre tenants. BYPASSRLS.
# Se ejecuta una sola vez, al inicializar el volumen de datos.
set -eu

psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres <<SQL
CREATE ROLE yebo_owner    LOGIN PASSWORD '${YEBO_OWNER_PASSWORD}'    NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE yebo_app      LOGIN PASSWORD '${YEBO_APP_PASSWORD}'      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE yebo_platform LOGIN PASSWORD '${YEBO_PLATFORM_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
SQL

# yebo_dev: desarrollo · yebo_test: pruebas de integración · yebo_poc_*: pruebas de concepto de la Fase 2
# yebo_shadow: base auxiliar para que Prisma detecte deriva entre migraciones y esquema
# yebo_migrations: base que las pruebas vacían para validar las migraciones desde cero y desde el esquema anterior
for db in yebo_dev yebo_test yebo_poc_tenancy yebo_poc_inventory yebo_shadow yebo_migrations; do
  psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres -c "CREATE DATABASE ${db} OWNER yebo_owner;"
  psql -v ON_ERROR_STOP=1 --username postgres --dbname "${db}" <<SQL
REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${db} TO yebo_owner, yebo_app, yebo_platform;
ALTER SCHEMA public OWNER TO yebo_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO yebo_app, yebo_platform;
-- Todo lo que cree yebo_owner queda disponible para la app y la plataforma con permisos DML (nunca DDL).
ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yebo_app, yebo_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO yebo_app, yebo_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO yebo_app, yebo_platform;
SQL
done
echo "YEBO: roles y bases de datos creados"
