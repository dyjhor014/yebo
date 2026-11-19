-- Fase 7.3a · Viajes, paradas copiadas e inventario materializado (data-dictionary §5; plan de la Fase 7, F7-Q3,
-- F7-Q4 y F7-Q6, aprobadas el 2026-11-18; capacity-and-inventory §2–4; ADR-010).
--   trips: viaje de una ruta en una fecha y hora (ON_DEMAND; los SCHEDULED llegan con las programaciones, 7.3b).
--     Estados de esta fase: PLANNED, OPEN_FOR_SALE y CANCELLED (trigger de transiciones; la Fase 8 lo amplía). Desde
--     la apertura, la unidad, el plano y las horas quedan fijos. Cancelado es definitivo. Sin DELETE.
--     Un vehículo no está en dos viajes no cancelados con horarios que se solapan (EXCLUDE). Una ruta no tiene dos
--     viajes no cancelados a la misma hora (UNIQUE parcial). Solo viajes compartidos (F7-Q6: los privados, Fase 8).
--   trip_stops: copiadas de la ruta al crear el viaje, con sus horas planificadas.
--   trip_resources y trip_capacity_pools: el inventario de la versión del plano (deriveInventory), materializado al
--     fijar la unidad y el plano; se reemplaza mientras el viaje está PLANNED (F7-Q3).
--   trip_pool_segment_usage: un contador por pool y tramo, creado al abrir la venta y borrado al volver a PLANNED
--     (sin ocupación). `used` solo lo moverá el motor de inventario (7.4): yebo_app no tiene UPDATE todavía.
--   Coherencia del viaje entero (paradas 0..n-1, y contadores = pools × tramos si está a la venta; ninguno si no):
--     trigger de restricción DIFERIDO, al confirmar.
--   Permiso trips.manage (plantilla Administrador).
--
-- Reversión (como yebo_owner; se pierden los viajes):
--   DROP TABLE "trip_pool_segment_usage", "trip_capacity_pools", "trip_resources", "trip_stops", "trips";
--   DROP FUNCTION "trips_guard"(), "trip_children_guard"(), "trip_segments_guard"(), "trip_consistency_check"();
--   DROP TYPE "trip_status", "departure_kind", "service_mode", "pool_scope";
--   -- Permiso trips.manage: quitarlo de role_permissions (tenant a tenant), de la plantilla ADMIN y de permissions.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261120010000_fase7_3a_trips';

-- CreateEnum
CREATE TYPE "trip_status" AS ENUM ('PLANNED', 'OPEN_FOR_SALE', 'CONFIRMED', 'BOARDING', 'DEPARTED', 'ARRIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "departure_kind" AS ENUM ('SCHEDULED', 'ON_DEMAND');

-- CreateEnum
CREATE TYPE "service_mode" AS ENUM ('SHARED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "pool_scope" AS ENUM ('ZONE', 'VEHICLE');

-- CreateTable
CREATE TABLE "trips" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "route_id" UUID NOT NULL,
    "departure_kind" "departure_kind" NOT NULL DEFAULT 'ON_DEMAND',
    "service_mode" "service_mode" NOT NULL DEFAULT 'SHARED',
    "vehicle_id" UUID,
    "layout_version_id" UUID,
    "status" "trip_status" NOT NULL DEFAULT 'PLANNED',
    "min_passengers" INTEGER,
    "confirmation_deadline" TIMESTAMPTZ(6),
    "planned_departure_at" TIMESTAMPTZ(6) NOT NULL,
    "planned_arrival_at" TIMESTAMPTZ(6) NOT NULL,
    "opened_at" TIMESTAMPTZ(6),
    "opened_by_kind" "membership_change_actor",
    "opened_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_kind" "membership_change_actor",
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_stops" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "location_id" UUID NOT NULL,
    "planned_arrival_at" TIMESTAMPTZ(6),
    "planned_departure_at" TIMESTAMPTZ(6),
    "allows_boarding" BOOLEAN NOT NULL,
    "allows_alighting" BOOLEAN NOT NULL,

    CONSTRAINT "trip_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_resources" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "layout_element_id" UUID NOT NULL,
    "parent_trip_resource_id" UUID,
    "code" TEXT NOT NULL,
    "kind" "layout_element_kind" NOT NULL,
    "zone_code" TEXT NOT NULL,
    "price_class_code" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "is_sellable" BOOLEAN NOT NULL,
    "sellable_as_unit" BOOLEAN NOT NULL,

    CONSTRAINT "trip_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_capacity_pools" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "scope" "pool_scope" NOT NULL,
    "zone_code" TEXT,
    "dimension" "capacity_dimension" NOT NULL,
    "capacity" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "trip_capacity_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_pool_segment_usage" (
    "tenant_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "segment_seq" INTEGER NOT NULL,
    "capacity" DECIMAL(14,3) NOT NULL,
    "used" DECIMAL(14,3) NOT NULL DEFAULT 0,

    CONSTRAINT "trip_pool_segment_usage_pkey" PRIMARY KEY ("pool_id","segment_seq")
);

-- CreateIndex
CREATE INDEX "trips_tenant_id_planned_departure_at_idx" ON "trips"("tenant_id", "planned_departure_at");

-- CreateIndex
CREATE INDEX "trips_tenant_id_route_id_idx" ON "trips"("tenant_id", "route_id");

-- CreateIndex
CREATE INDEX "trips_tenant_id_vehicle_id_idx" ON "trips"("tenant_id", "vehicle_id");

-- CreateIndex
CREATE INDEX "trips_tenant_id_layout_version_id_idx" ON "trips"("tenant_id", "layout_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "trips_tenant_id_id_key" ON "trips"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trips_tenant_id_code_key" ON "trips"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "trip_stops_tenant_id_trip_id_idx" ON "trip_stops"("tenant_id", "trip_id");

-- CreateIndex
CREATE INDEX "trip_stops_tenant_id_location_id_idx" ON "trip_stops"("tenant_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_stops_tenant_id_id_key" ON "trip_stops"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_stops_trip_id_seq_key" ON "trip_stops"("trip_id", "seq");

-- CreateIndex
CREATE INDEX "trip_resources_tenant_id_trip_id_idx" ON "trip_resources"("tenant_id", "trip_id");

-- CreateIndex
CREATE INDEX "trip_resources_tenant_id_layout_element_id_idx" ON "trip_resources"("tenant_id", "layout_element_id");

-- CreateIndex
CREATE INDEX "trip_resources_tenant_id_parent_trip_resource_id_idx" ON "trip_resources"("tenant_id", "parent_trip_resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_resources_tenant_id_id_key" ON "trip_resources"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_resources_trip_id_code_key" ON "trip_resources"("trip_id", "code");

-- CreateIndex
CREATE INDEX "trip_capacity_pools_tenant_id_trip_id_idx" ON "trip_capacity_pools"("tenant_id", "trip_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_capacity_pools_tenant_id_id_key" ON "trip_capacity_pools"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "trip_pool_segment_usage_tenant_id_pool_id_idx" ON "trip_pool_segment_usage"("tenant_id", "pool_id");

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_tenant_id_route_id_fkey" FOREIGN KEY ("tenant_id", "route_id") REFERENCES "routes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_tenant_id_vehicle_id_fkey" FOREIGN KEY ("tenant_id", "vehicle_id") REFERENCES "vehicles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_tenant_id_layout_version_id_fkey" FOREIGN KEY ("tenant_id", "layout_version_id") REFERENCES "layout_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_tenant_id_trip_id_fkey" FOREIGN KEY ("tenant_id", "trip_id") REFERENCES "trips"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_resources" ADD CONSTRAINT "trip_resources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_resources" ADD CONSTRAINT "trip_resources_tenant_id_trip_id_fkey" FOREIGN KEY ("tenant_id", "trip_id") REFERENCES "trips"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_resources" ADD CONSTRAINT "trip_resources_tenant_id_layout_element_id_fkey" FOREIGN KEY ("tenant_id", "layout_element_id") REFERENCES "layout_elements"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_resources" ADD CONSTRAINT "trip_resources_tenant_id_parent_trip_resource_id_fkey" FOREIGN KEY ("tenant_id", "parent_trip_resource_id") REFERENCES "trip_resources"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_capacity_pools" ADD CONSTRAINT "trip_capacity_pools_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_capacity_pools" ADD CONSTRAINT "trip_capacity_pools_tenant_id_trip_id_fkey" FOREIGN KEY ("tenant_id", "trip_id") REFERENCES "trips"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_pool_segment_usage" ADD CONSTRAINT "trip_pool_segment_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_pool_segment_usage" ADD CONSTRAINT "trip_pool_segment_usage_tenant_id_pool_id_fkey" FOREIGN KEY ("tenant_id", "pool_id") REFERENCES "trip_capacity_pools"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- ============================================================================
-- Reglas de cada fila
-- ============================================================================
ALTER TABLE "trips"
  ADD CONSTRAINT "trips_code" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'),
  ADD CONSTRAINT "trips_times" CHECK ("planned_arrival_at" > "planned_departure_at"),
  ADD CONSTRAINT "trips_min_passengers" CHECK ("min_passengers" IS NULL OR "min_passengers" BETWEEN 1 AND 1000),
  ADD CONSTRAINT "trips_confirmation" CHECK (
    "confirmation_deadline" IS NULL OR "confirmation_deadline" < "planned_departure_at"),
  -- F7-Q6: los viajes privados (fletamento) llegan con la Fase 8.
  ADD CONSTRAINT "trips_shared" CHECK ("service_mode" = 'SHARED'),
  ADD CONSTRAINT "trips_layout_needs_vehicle" CHECK ("layout_version_id" IS NULL OR "vehicle_id" IS NOT NULL),
  ADD CONSTRAINT "trips_opened" CHECK (
    ("opened_at" IS NULL) = ("opened_by_kind" IS NULL) AND ("opened_by_kind" IS NULL) = ("opened_by_id" IS NULL)
    AND ("opened_by_kind" IS NULL OR "opened_by_kind" IN ('MEMBERSHIP', 'PLATFORM_USER', 'SYSTEM'))),
  ADD CONSTRAINT "trips_open_for_sale" CHECK (
    "status" <> 'OPEN_FOR_SALE' OR ("opened_at" IS NOT NULL AND "layout_version_id" IS NOT NULL)),
  ADD CONSTRAINT "trips_cancelled" CHECK (
    ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
    AND ("cancelled_at" IS NULL) = ("cancelled_by_kind" IS NULL)
    AND ("cancelled_by_kind" IS NULL) = ("cancelled_by_id" IS NULL)
    AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
    AND ("cancelled_by_kind" IS NULL OR "cancelled_by_kind" IN ('MEMBERSHIP', 'PLATFORM_USER', 'SYSTEM'))),
  ADD CONSTRAINT "trips_cancel_reason" CHECK (
    "cancel_reason" IS NULL OR ("cancel_reason" = btrim("cancel_reason") AND char_length("cancel_reason") BETWEEN 3 AND 300)),
  -- Un vehículo, un viaje a la vez: los horarios [salida, llegada) de sus viajes no cancelados no se solapan.
  ADD CONSTRAINT "trips_vehicle_no_overlap" EXCLUDE USING gist (
    "tenant_id" WITH =, "vehicle_id" WITH =, tstzrange("planned_departure_at", "planned_arrival_at", '[)') WITH &&)
    WHERE ("vehicle_id" IS NOT NULL AND "status" <> 'CANCELLED');

-- Una ruta no sale dos veces a la misma hora (salvo viajes cancelados).
CREATE UNIQUE INDEX "trips_route_departure_key" ON "trips" ("route_id", "planned_departure_at")
  WHERE "status" <> 'CANCELLED';

ALTER TABLE "trip_stops"
  ADD CONSTRAINT "trip_stops_seq" CHECK ("seq" BETWEEN 0 AND 49),
  ADD CONSTRAINT "trip_stops_times" CHECK (
    "planned_arrival_at" IS NULL OR "planned_departure_at" IS NULL OR "planned_departure_at" >= "planned_arrival_at"),
  ADD CONSTRAINT "trip_stops_has_time" CHECK ("planned_arrival_at" IS NOT NULL OR "planned_departure_at" IS NOT NULL);

ALTER TABLE "trip_resources"
  ADD CONSTRAINT "trip_resources_kind" CHECK ("kind" IN ('SEAT', 'BED', 'CABIN', 'VEHICLE_SLOT')),
  ADD CONSTRAINT "trip_resources_capacity" CHECK ("capacity" BETWEEN 1 AND 100),
  ADD CONSTRAINT "trip_resources_price_class" CHECK ("price_class_code" ~ '^[A-Z][A-Z0-9_]{1,23}$'),
  -- Un camarote con camas no se vende solo: se venden sus camas (o todas a la vez si se vende completo).
  ADD CONSTRAINT "trip_resources_unit" CHECK (NOT ("is_sellable" AND "sellable_as_unit"));

ALTER TABLE "trip_capacity_pools"
  ADD CONSTRAINT "trip_capacity_pools_capacity" CHECK ("capacity" > 0),
  ADD CONSTRAINT "trip_capacity_pools_scope" CHECK (
    ("scope" = 'ZONE' AND "zone_code" IS NOT NULL)
    OR ("scope" = 'VEHICLE' AND "zone_code" IS NULL AND "dimension" = 'PERSONS'));
-- Un pool por zona y dimensión, y un aforo de la unidad por viaje (dos índices parciales: Prisma no representa NULLS
-- NOT DISTINCT y lo vería como deriva).
CREATE UNIQUE INDEX "trip_capacity_pools_zone_key" ON "trip_capacity_pools" ("trip_id", "zone_code", "dimension")
  WHERE "scope" = 'ZONE';
CREATE UNIQUE INDEX "trip_capacity_pools_vehicle_key" ON "trip_capacity_pools" ("trip_id")
  WHERE "scope" = 'VEHICLE';

ALTER TABLE "trip_pool_segment_usage"
  ADD CONSTRAINT "trip_pool_segment_usage_seq" CHECK ("segment_seq" BETWEEN 0 AND 48),
  ADD CONSTRAINT "pool_within_capacity" CHECK ("capacity" > 0 AND "used" >= 0 AND "used" <= "capacity");

-- ============================================================================
-- Estados del viaje (F7-Q4) y lo que queda fijo desde la apertura (F7-Q3)
-- ============================================================================
CREATE FUNCTION "trips_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PLANNED' THEN
      RAISE EXCEPTION 'trips: un viaje nace planificado' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'trips: un viaje cancelado no cambia' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PLANNED' AND NEW.status IN ('OPEN_FOR_SALE', 'CANCELLED'))
    OR (OLD.status = 'OPEN_FOR_SALE' AND NEW.status IN ('PLANNED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'trips: no se pasa de % a %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'PLANNED' AND (
       NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
    OR NEW.layout_version_id IS DISTINCT FROM OLD.layout_version_id
    OR NEW.planned_departure_at <> OLD.planned_departure_at
    OR NEW.planned_arrival_at <> OLD.planned_arrival_at
    OR NEW.code <> OLD.code
    OR NEW.min_passengers IS DISTINCT FROM OLD.min_passengers
    OR NEW.confirmation_deadline IS DISTINCT FROM OLD.confirmation_deadline) THEN
    RAISE EXCEPTION 'trips: la unidad, el plano y las horas quedan fijos desde la apertura de la venta'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "trips_guard" BEFORE INSERT OR UPDATE ON "trips" FOR EACH ROW EXECUTE FUNCTION "trips_guard"();

-- Paradas e inventario: solo cambian con el viaje planificado.
CREATE FUNCTION "trip_children_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.trip_id ELSE NEW.trip_id END;
  st trip_status;
BEGIN
  SELECT status INTO st FROM "trips" WHERE id = t_id;
  IF st IS DISTINCT FROM 'PLANNED' THEN
    RAISE EXCEPTION '%: las paradas y el inventario solo cambian con el viaje planificado', TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER "trip_stops_guard" BEFORE INSERT OR UPDATE OR DELETE ON "trip_stops"
  FOR EACH ROW EXECUTE FUNCTION "trip_children_guard"();
CREATE TRIGGER "trip_resources_guard" BEFORE INSERT OR UPDATE OR DELETE ON "trip_resources"
  FOR EACH ROW EXECUTE FUNCTION "trip_children_guard"();
CREATE TRIGGER "trip_capacity_pools_guard" BEFORE INSERT OR UPDATE OR DELETE ON "trip_capacity_pools"
  FOR EACH ROW EXECUTE FUNCTION "trip_children_guard"();

-- Contadores por tramo: se crean con el viaje a la venta y se borran, vacíos, con el viaje planificado.
CREATE FUNCTION "trip_segments_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.pool_id ELSE NEW.pool_id END;
  st trip_status;
BEGIN
  SELECT t.status INTO st FROM "trip_capacity_pools" p JOIN "trips" t ON t.id = p.trip_id WHERE p.id = p_id;
  IF TG_OP = 'INSERT' AND st IS DISTINCT FROM 'OPEN_FOR_SALE' THEN
    RAISE EXCEPTION 'trip_pool_segment_usage: los tramos se materializan al abrir la venta' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' AND (st IS DISTINCT FROM 'PLANNED' OR OLD.used <> 0) THEN
    RAISE EXCEPTION 'trip_pool_segment_usage: solo se borran tramos sin ocupación al volver a planificar'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER "trip_pool_segment_usage_guard" BEFORE INSERT OR DELETE ON "trip_pool_segment_usage"
  FOR EACH ROW EXECUTE FUNCTION "trip_segments_guard"();

-- ============================================================================
-- Coherencia del viaje entero (trigger de restricción diferido: se comprueba al confirmar)
-- ============================================================================
-- Una sola función de trigger (sin función auxiliar: yebo_app no tiene EXECUTE sobre funciones, ADR-034). Con IF y no
-- CASE: PL/pgSQL resuelve los campos de cada rama, y trips no tiene trip_id.
CREATE FUNCTION "trip_consistency_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t_id uuid;
  st trip_status;
  n_stops int;
  bad_seq boolean;
  n_pools int;
  n_rows int;
  bad_cap boolean;
BEGIN
  IF TG_TABLE_NAME = 'trips' THEN
    t_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'trip_stops' THEN
    IF TG_OP = 'DELETE' THEN t_id := OLD.trip_id; ELSE t_id := NEW.trip_id; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT trip_id INTO t_id FROM "trip_capacity_pools" WHERE id = OLD.pool_id;
  ELSE
    SELECT trip_id INTO t_id FROM "trip_capacity_pools" WHERE id = NEW.pool_id;
  END IF;
  SELECT status INTO st FROM "trips" WHERE id = t_id;
  IF st IS NULL THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(bool_or(seq <> pos), false) INTO n_stops, bad_seq
    FROM (SELECT seq, (row_number() OVER (ORDER BY seq) - 1)::int AS pos FROM "trip_stops" WHERE trip_id = t_id) s;
  IF n_stops < 2 OR bad_seq THEN
    RAISE EXCEPTION 'trips: las paradas del viaje van de 0 a n-1 y son al menos dos' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO n_pools FROM "trip_capacity_pools" WHERE trip_id = t_id;
  SELECT count(*), coalesce(bool_or(u.capacity <> p.capacity OR u.segment_seq >= n_stops - 1), false)
    INTO n_rows, bad_cap
    FROM "trip_pool_segment_usage" u JOIN "trip_capacity_pools" p ON p.id = u.pool_id WHERE p.trip_id = t_id;
  IF st = 'OPEN_FOR_SALE' AND (n_rows <> n_pools * (n_stops - 1) OR bad_cap) THEN
    RAISE EXCEPTION 'trips: un viaje a la venta tiene un contador por pool y tramo, con la capacidad del pool'
      USING ERRCODE = 'P0001';
  END IF;
  IF st = 'PLANNED' AND n_rows > 0 THEN
    RAISE EXCEPTION 'trips: un viaje planificado no tiene contadores por tramo' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "trips_consistency" AFTER INSERT OR UPDATE ON "trips"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trip_consistency_check"();
CREATE CONSTRAINT TRIGGER "trip_stops_consistency" AFTER INSERT OR UPDATE OR DELETE ON "trip_stops"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trip_consistency_check"();
CREATE CONSTRAINT TRIGGER "trip_pool_segment_usage_consistency" AFTER INSERT OR DELETE ON "trip_pool_segment_usage"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "trip_consistency_check"();

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025)
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trips', 'trip_stops', 'trip_resources', 'trip_capacity_pools', 'trip_pool_segment_usage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ============================================================================
-- Privilegios (ADR-034)
-- ============================================================================
-- yebo_app: los viajes no se borran; su ruta, su tipo y su modo no cambian.
GRANT SELECT, INSERT ON "trips" TO yebo_app;
GRANT UPDATE ("code", "vehicle_id", "layout_version_id", "status", "min_passengers", "confirmation_deadline",
              "planned_departure_at", "planned_arrival_at", "opened_at", "opened_by_kind", "opened_by_id",
              "cancelled_at", "cancelled_by_kind", "cancelled_by_id", "cancel_reason", "updated_at") ON "trips" TO yebo_app;
-- Las paradas se copian una vez; solo cambian sus horas (con el viaje planificado).
GRANT SELECT, INSERT ON "trip_stops" TO yebo_app;
GRANT UPDATE ("planned_arrival_at", "planned_departure_at") ON "trip_stops" TO yebo_app;
-- El inventario se reemplaza entero mientras el viaje está planificado.
GRANT SELECT, INSERT, DELETE ON "trip_resources", "trip_capacity_pools" TO yebo_app;
-- Los contadores se crean al abrir y se borran al volver a planificar; `used` lo moverá el motor (7.4).
GRANT SELECT, INSERT, DELETE ON "trip_pool_segment_usage" TO yebo_app;
-- yebo_backoffice: el panel de YEBO los ve.
GRANT SELECT ON "trips", "trip_stops", "trip_resources", "trip_capacity_pools", "trip_pool_segment_usage"
  TO yebo_backoffice;

-- ============================================================================
-- Permiso trips.manage (fuente: permission-catalog.ts)
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'trips.manage', 'TRIPS', 'Gestionar los viajes y abrirlos a la venta', false, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates" SET "permission_codes" = "permission_codes" || ARRAY['trips.manage']::text[],
       "updated_at" = now()
 WHERE "code" = 'ADMIN' AND NOT ('trips.manage' = ANY ("permission_codes"));

-- Roles ya creados desde la plantilla Administrador (tenant a tenant por el RLS forzado).
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
      SELECT r.tenant_id, r.id, p.id
        FROM "roles" r JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
        CROSS JOIN "permissions" p
       WHERE p.code = 'trips.manage'
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
