-- Fase 7.3b · Programaciones (data-dictionary §5; plan de la Fase 7, F7-Q2, aprobada el 2026-11-18).
--   schedules: de tenant, con RLS forzado. Salidas de una ruta con un subconjunto de RRULE (FREQ=DAILY o
--   FREQ=WEEKLY;BYDAY=…), una hora local (HH:MM) en la zona de la empresa (copiada al crearla), vigencia
--   [valid_from, valid_to), fechas excluidas y la unidad y el plano por defecto. Su código, su ruta, su zona y su modo
--   no cambian; se archiva, no se borra (los viajes generados la referencian).
--   trips: schedule_id y departure_date (fecha local de la salida) en los viajes SCHEDULED. UNIQUE (schedule_id,
--   departure_date): generar es idempotente, y un viaje generado y cancelado no se vuelve a generar. Ninguna de las dos
--   columnas cambia después de crear el viaje (sin privilegio de UPDATE).
--   Sin permiso nuevo: las programaciones son de trips.manage (crear y generar son NEW_COMMERCIAL).
--   Requisito: no hay viajes SCHEDULED previos (la 7.3a solo crea ON_DEMAND); si los hubiera, el CHECK trips_schedule
--   fallaría y Prisma dejaría la migración a medias (no la envuelve en una transacción).
--
-- Reversión (como yebo_owner; se pierden las programaciones y los viajes quedan sin ella):
--   ALTER TABLE "trips" DROP CONSTRAINT "trips_schedule"; DROP INDEX "trips_schedule_id_departure_date_key";
--   ALTER TABLE "trips" DROP COLUMN "schedule_id", DROP COLUMN "departure_date";
--   DROP TABLE "schedules";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261121010000_fase7_3b_schedules';

-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "departure_date" DATE,
ADD COLUMN     "schedule_id" UUID;

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "route_id" UUID NOT NULL,
    "recurrence" TEXT NOT NULL,
    "departure_local_time" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "default_vehicle_id" UUID,
    "default_layout_version_id" UUID,
    "service_mode" "service_mode" NOT NULL DEFAULT 'SHARED',
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "excluded_dates" DATE[] DEFAULT ARRAY[]::DATE[],
    "generated_until" DATE,
    "last_generated_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedules_tenant_id_route_id_idx" ON "schedules"("tenant_id", "route_id");

-- CreateIndex
CREATE INDEX "schedules_tenant_id_default_vehicle_id_idx" ON "schedules"("tenant_id", "default_vehicle_id");

-- CreateIndex
CREATE INDEX "schedules_tenant_id_default_layout_version_id_idx" ON "schedules"("tenant_id", "default_layout_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_tenant_id_id_key" ON "schedules"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_tenant_id_code_key" ON "schedules"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "trips_tenant_id_schedule_id_idx" ON "trips"("tenant_id", "schedule_id");

-- CreateIndex
CREATE UNIQUE INDEX "trips_schedule_id_departure_date_key" ON "trips"("schedule_id", "departure_date");

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_tenant_id_schedule_id_fkey" FOREIGN KEY ("tenant_id", "schedule_id") REFERENCES "schedules"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_tenant_id_route_id_fkey" FOREIGN KEY ("tenant_id", "route_id") REFERENCES "routes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_tenant_id_default_vehicle_id_fkey" FOREIGN KEY ("tenant_id", "default_vehicle_id") REFERENCES "vehicles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_tenant_id_default_layout_version_id_fkey" FOREIGN KEY ("tenant_id", "default_layout_version_id") REFERENCES "layout_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- ============================================================================
-- Reglas de cada fila
-- ============================================================================
ALTER TABLE "schedules"
  ADD CONSTRAINT "schedules_code" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{1,23}$'),
  -- F7-Q2: diaria, o semanal por días (en orden, sin repetir: lo normaliza la API).
  ADD CONSTRAINT "schedules_recurrence" CHECK (
    "recurrence" ~ '^FREQ=(DAILY|WEEKLY;BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU)){0,6})$'),
  ADD CONSTRAINT "schedules_time" CHECK ("departure_local_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT "schedules_timezone" CHECK (char_length("timezone") BETWEEN 3 AND 64),
  ADD CONSTRAINT "schedules_shared" CHECK ("service_mode" = 'SHARED'),
  ADD CONSTRAINT "schedules_layout_needs_vehicle" CHECK (
    "default_layout_version_id" IS NULL OR "default_vehicle_id" IS NOT NULL),
  ADD CONSTRAINT "schedules_dates" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from"),
  ADD CONSTRAINT "schedules_excluded" CHECK (
    "excluded_dates" IS NOT NULL AND cardinality("excluded_dates") <= 100);

-- Un viaje SCHEDULED tiene su programación y su fecha local; uno ON_DEMAND, ninguna.
ALTER TABLE "trips"
  ADD CONSTRAINT "trips_schedule" CHECK (
    ("departure_kind" = 'SCHEDULED') = ("schedule_id" IS NOT NULL)
    AND ("schedule_id" IS NULL) = ("departure_date" IS NULL));

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025)
-- ============================================================================
ALTER TABLE "schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "schedules" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "schedules"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============================================================================
-- Privilegios (ADR-034)
-- ============================================================================
-- yebo_app: no se borra; su código, su ruta, su zona horaria y su modo no cambian.
GRANT SELECT, INSERT ON "schedules" TO yebo_app;
GRANT UPDATE ("recurrence", "departure_local_time", "default_vehicle_id", "default_layout_version_id", "valid_from",
              "valid_to", "excluded_dates", "generated_until", "last_generated_at", "archived_at", "updated_at")
  ON "schedules" TO yebo_app;
GRANT SELECT ON "schedules" TO yebo_backoffice;
