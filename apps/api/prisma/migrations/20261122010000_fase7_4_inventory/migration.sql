-- Fase 7.4 · Motor de inventario por tramo y bloqueos operativos (capacity-and-inventory §3–6; ADR-007 y ADR-026;
-- plan de la Fase 7, F7-Q5, aprobada el 2026-11-18).
--   resource_allocations: un recurso asignable (asiento, cama, camarote sin camas, espacio de vehículo) ocupado en el
--     rango de paradas [a, b). EXCLUDE gist (recurso, rango) entre las no liberadas: no hay doble venta (§3).
--   pool_allocations: una cantidad de un pool ocupada en [a, b); su suma por tramo es trip_pool_segment_usage.used
--     (§4; la reconciliación lo comprueba). El contador se mueve con bloqueo ordenado (pool_id, segment_seq) y su CHECK
--     (pool_within_capacity) es la red final.
--   Ninguna asignación se borra: se libera (RELEASED es definitivo). Una retención (HELD) tiene vencimiento. Solo se
--   asigna en un viaje a la venta, dentro de sus tramos, y nunca un camarote que se vende por sus camas.
--   trip_blocks: bloqueos operativos (tripulación, mantenimiento, cortesía…), titulares BLOCK de sus asignaciones; guardan
--     quién los crea y quién los libera.
--   trip_consistency_check (7.3a) suma: un viaje planificado no tiene ocupación.
--   yebo_app recibe UPDATE de trip_pool_segment_usage.used (el motor). Permiso trips.block (plantilla Administrador).
--
-- Reversión (como yebo_owner; se pierde la ocupación):
--   DROP TABLE "resource_allocations", "pool_allocations", "trip_blocks";
--   DROP FUNCTION "allocations_guard"(); DROP TYPE "allocation_status", "allocation_holder", "block_reason";
--   DROP INDEX "trip_resources_trip_id_id_key"; REVOKE UPDATE ("used") ON "trip_pool_segment_usage" FROM yebo_app;
--   -- trip_consistency_check: volver a la versión de la 20261120010000_fase7_3a_trips.
--   -- Permiso trips.block: quitarlo de role_permissions (tenant a tenant), de la plantilla ADMIN y de permissions.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261122010000_fase7_4_inventory';

-- CreateEnum
CREATE TYPE "allocation_status" AS ENUM ('HELD', 'CONFIRMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "allocation_holder" AS ENUM ('BOOKING_ITEM', 'TRANSFER', 'CARGO_ASSIGNMENT', 'BLOCK');

-- CreateEnum
CREATE TYPE "block_reason" AS ENUM ('CREW', 'MAINTENANCE', 'COURTESY', 'OTHER');

-- CreateTable
CREATE TABLE "resource_allocations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "trip_resource_id" UUID NOT NULL,
    "stop_range" int4range NOT NULL,
    "status" "allocation_status" NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(6),
    "holder_type" "allocation_holder" NOT NULL,
    "holder_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),

    CONSTRAINT "resource_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_allocations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "stop_range" int4range NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "status" "allocation_status" NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(6),
    "holder_type" "allocation_holder" NOT NULL,
    "holder_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),

    CONSTRAINT "pool_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_blocks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "reason" "block_reason" NOT NULL,
    "note" TEXT,
    "from_seq" INTEGER NOT NULL,
    "to_seq" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_kind" "membership_change_actor" NOT NULL,
    "created_by_id" UUID NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "released_by_kind" "membership_change_actor",
    "released_by_id" UUID,

    CONSTRAINT "trip_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resource_allocations_tenant_id_trip_id_idx" ON "resource_allocations"("tenant_id", "trip_id");

-- CreateIndex
CREATE INDEX "resource_allocations_tenant_id_holder_id_idx" ON "resource_allocations"("tenant_id", "holder_id");

-- CreateIndex
CREATE INDEX "resource_allocations_trip_id_trip_resource_id_idx" ON "resource_allocations"("trip_id", "trip_resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_allocations_tenant_id_id_key" ON "resource_allocations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "pool_allocations_tenant_id_pool_id_idx" ON "pool_allocations"("tenant_id", "pool_id");

-- CreateIndex
CREATE INDEX "pool_allocations_tenant_id_holder_id_idx" ON "pool_allocations"("tenant_id", "holder_id");

-- CreateIndex
CREATE UNIQUE INDEX "pool_allocations_tenant_id_id_key" ON "pool_allocations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "trip_blocks_tenant_id_trip_id_idx" ON "trip_blocks"("tenant_id", "trip_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_blocks_tenant_id_id_key" ON "trip_blocks"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_resources_trip_id_id_key" ON "trip_resources"("trip_id", "id");

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_tenant_id_trip_id_fkey" FOREIGN KEY ("tenant_id", "trip_id") REFERENCES "trips"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_trip_id_trip_resource_id_fkey" FOREIGN KEY ("trip_id", "trip_resource_id") REFERENCES "trip_resources"("trip_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pool_allocations" ADD CONSTRAINT "pool_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pool_allocations" ADD CONSTRAINT "pool_allocations_tenant_id_pool_id_fkey" FOREIGN KEY ("tenant_id", "pool_id") REFERENCES "trip_capacity_pools"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_blocks" ADD CONSTRAINT "trip_blocks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_blocks" ADD CONSTRAINT "trip_blocks_tenant_id_trip_id_fkey" FOREIGN KEY ("tenant_id", "trip_id") REFERENCES "trips"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- ============================================================================
-- Reglas de cada fila
-- ============================================================================
ALTER TABLE "resource_allocations"
  ADD CONSTRAINT "resource_allocations_range" CHECK (NOT isempty("stop_range") AND lower("stop_range") >= 0),
  ADD CONSTRAINT "resource_allocations_hold" CHECK ("status" <> 'HELD' OR "hold_expires_at" IS NOT NULL),
  ADD CONSTRAINT "resource_allocations_released" CHECK (("status" = 'RELEASED') = ("released_at" IS NOT NULL)),
  -- §3: un recurso, un titular por tramo (las liberadas no cuentan).
  ADD CONSTRAINT "resource_no_overlap" EXCLUDE USING gist ("trip_resource_id" WITH =, "stop_range" WITH &&)
    WHERE ("status" <> 'RELEASED');

ALTER TABLE "pool_allocations"
  ADD CONSTRAINT "pool_allocations_range" CHECK (NOT isempty("stop_range") AND lower("stop_range") >= 0),
  ADD CONSTRAINT "pool_allocations_quantity" CHECK ("quantity" > 0),
  ADD CONSTRAINT "pool_allocations_hold" CHECK ("status" <> 'HELD' OR "hold_expires_at" IS NOT NULL),
  ADD CONSTRAINT "pool_allocations_released" CHECK (("status" = 'RELEASED') = ("released_at" IS NOT NULL));
CREATE INDEX "pool_allocations_active_idx" ON "pool_allocations" ("pool_id") WHERE "status" <> 'RELEASED';

ALTER TABLE "trip_blocks"
  ADD CONSTRAINT "trip_blocks_range" CHECK ("from_seq" >= 0 AND "to_seq" > "from_seq" AND "to_seq" <= 49),
  ADD CONSTRAINT "trip_blocks_note" CHECK ("note" IS NULL OR ("note" = btrim("note") AND char_length("note") BETWEEN 2 AND 300)),
  ADD CONSTRAINT "trip_blocks_created_by" CHECK ("created_by_kind" IN ('MEMBERSHIP', 'PLATFORM_USER', 'SYSTEM')),
  ADD CONSTRAINT "trip_blocks_released" CHECK (
    ("released_at" IS NULL) = ("released_by_kind" IS NULL) AND ("released_by_kind" IS NULL) = ("released_by_id" IS NULL)
    AND ("released_by_kind" IS NULL OR "released_by_kind" IN ('MEMBERSHIP', 'PLATFORM_USER', 'SYSTEM')));

-- ============================================================================
-- Guardia de las asignaciones: viaje a la venta, dentro de sus tramos, transiciones y liberación definitiva
-- ============================================================================
CREATE FUNCTION "allocations_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t_id uuid;
  st trip_status;
  n_stops int;
  sellable boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'RELEASED' THEN
      RAISE EXCEPTION '%: una asignación liberada no cambia', TG_TABLE_NAME USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'HELD' AND NEW.status IN ('CONFIRMED', 'RELEASED'))
      OR (OLD.status = 'CONFIRMED' AND NEW.status = 'RELEASED')) THEN
      RAISE EXCEPTION '%: no se pasa de % a %', TG_TABLE_NAME, OLD.status, NEW.status USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'RELEASED' THEN
    RAISE EXCEPTION '%: una asignación nace retenida o confirmada', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  -- Con IF (no CASE): PL/pgSQL resuelve los campos de cada rama, y cada tabla tiene los suyos.
  IF TG_TABLE_NAME = 'resource_allocations' THEN
    t_id := NEW.trip_id;
    SELECT r.is_sellable INTO sellable FROM "trip_resources" r WHERE r.id = NEW.trip_resource_id;
    IF NOT coalesce(sellable, false) THEN
      RAISE EXCEPTION 'resource_allocations: el recurso no se vende solo (un camarote se vende por sus camas)'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT trip_id INTO t_id FROM "trip_capacity_pools" WHERE id = NEW.pool_id;
  END IF;
  SELECT status INTO st FROM "trips" WHERE id = t_id;
  IF st IS DISTINCT FROM 'OPEN_FOR_SALE' THEN
    RAISE EXCEPTION '%: solo se asigna inventario de un viaje a la venta', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO n_stops FROM "trip_stops" WHERE trip_id = t_id;
  IF upper(NEW.stop_range) > n_stops - 1 THEN
    RAISE EXCEPTION '%: el rango está fuera de los tramos del viaje', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "resource_allocations_guard" BEFORE INSERT OR UPDATE ON "resource_allocations"
  FOR EACH ROW EXECUTE FUNCTION "allocations_guard"();
CREATE TRIGGER "pool_allocations_guard" BEFORE INSERT OR UPDATE ON "pool_allocations"
  FOR EACH ROW EXECUTE FUNCTION "allocations_guard"();

-- ============================================================================
-- Coherencia del viaje (7.3a): además, un viaje planificado no tiene ocupación
-- ============================================================================
CREATE OR REPLACE FUNCTION "trip_consistency_check"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- Fase 7.4: un viaje planificado no tiene ocupación (asignaciones de recursos ni de cupos sin liberar).
  IF st = 'PLANNED' AND (
       EXISTS (SELECT 1 FROM "resource_allocations" WHERE trip_id = t_id AND status <> 'RELEASED')
    OR EXISTS (SELECT 1 FROM "pool_allocations" a JOIN "trip_capacity_pools" p ON p.id = a.pool_id
                WHERE p.trip_id = t_id AND a.status <> 'RELEASED')) THEN
    RAISE EXCEPTION 'trips: un viaje planificado no tiene ocupación' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025)
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['resource_allocations', 'pool_allocations', 'trip_blocks'] LOOP
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
-- yebo_app: las asignaciones se crean y se liberan (o se confirman); no se borran ni cambian su recurso, rango o titular.
GRANT SELECT, INSERT ON "resource_allocations", "pool_allocations" TO yebo_app;
GRANT UPDATE ("status", "released_at") ON "resource_allocations", "pool_allocations" TO yebo_app;
GRANT SELECT, INSERT ON "trip_blocks" TO yebo_app;
GRANT UPDATE ("released_at", "released_by_kind", "released_by_id") ON "trip_blocks" TO yebo_app;
-- El motor mueve los contadores (con bloqueo ordenado; el CHECK pool_within_capacity es la red final).
GRANT UPDATE ("used") ON "trip_pool_segment_usage" TO yebo_app;
GRANT SELECT ON "resource_allocations", "pool_allocations", "trip_blocks" TO yebo_backoffice;

-- ============================================================================
-- Permiso trips.block (fuente: permission-catalog.ts)
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'trips.block', 'TRIPS', 'Bloquear y liberar asientos y cupos de un viaje', false, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates" SET "permission_codes" = "permission_codes" || ARRAY['trips.block']::text[],
       "updated_at" = now()
 WHERE "code" = 'ADMIN' AND NOT ('trips.block' = ANY ("permission_codes"));

DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
      SELECT r.tenant_id, r.id, p.id
        FROM "roles" r JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
        CROSS JOIN "permissions" p
       WHERE p.code = 'trips.block'
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
