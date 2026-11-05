-- PRUEBA DE CONCEPTO (Fase 2): inventario por tramos. Tablas generadas por Prisma + restricciones en SQL.

CREATE EXTENSION IF NOT EXISTS btree_gist;


-- CreateTable
CREATE TABLE "inv_trips" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "stop_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN_FOR_SALE',

    CONSTRAINT "inv_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_trip_resources" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "parent_id" UUID,

    CONSTRAINT "inv_trip_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_resource_allocations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "trip_resource_id" UUID NOT NULL,
    "stop_range" int4range NOT NULL,
    "status" TEXT NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(6),
    "holder_type" TEXT NOT NULL,
    "holder_id" UUID NOT NULL,

    CONSTRAINT "inv_resource_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_pools" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "capacity" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "inv_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inv_pool_segment_usage" (
    "tenant_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "segment_seq" INTEGER NOT NULL,
    "capacity" DECIMAL(14,3) NOT NULL,
    "used" DECIMAL(14,3) NOT NULL DEFAULT 0,

    CONSTRAINT "inv_pool_segment_usage_pkey" PRIMARY KEY ("pool_id","segment_seq")
);

-- CreateTable
CREATE TABLE "inv_pool_allocations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "stop_range" int4range NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "status" TEXT NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(6),
    "holder_type" TEXT NOT NULL,
    "holder_id" UUID NOT NULL,

    CONSTRAINT "inv_pool_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inv_trips_tenant_id_id_key" ON "inv_trips"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "inv_trip_resources_tenant_id_parent_id_idx" ON "inv_trip_resources"("tenant_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "inv_trip_resources_tenant_id_id_key" ON "inv_trip_resources"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inv_trip_resources_trip_id_code_key" ON "inv_trip_resources"("trip_id", "code");

-- CreateIndex
CREATE INDEX "inv_resource_allocations_tenant_id_holder_id_idx" ON "inv_resource_allocations"("tenant_id", "holder_id");

-- CreateIndex
CREATE UNIQUE INDEX "inv_pools_tenant_id_id_key" ON "inv_pools"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inv_pools_trip_id_code_dimension_key" ON "inv_pools"("trip_id", "code", "dimension");

-- CreateIndex
CREATE INDEX "inv_pool_allocations_tenant_id_holder_id_idx" ON "inv_pool_allocations"("tenant_id", "holder_id");

-- AddForeignKey
ALTER TABLE "inv_trip_resources" ADD CONSTRAINT "inv_trip_resources_tenant_id_trip_id_fkey" FOREIGN KEY ("tenant_id", "trip_id") REFERENCES "inv_trips"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inv_pools" ADD CONSTRAINT "inv_pools_tenant_id_trip_id_fkey" FOREIGN KEY ("tenant_id", "trip_id") REFERENCES "inv_trips"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ============================================================================
-- Restricciones que Prisma no modela (capacity-and-inventory §3 y §4)
-- ============================================================================

-- Recursos asignables: imposible asignar el mismo recurso en tramos solapados.
ALTER TABLE "inv_resource_allocations"
  ADD CONSTRAINT "inv_resource_allocations_range_not_empty" CHECK (NOT isempty(stop_range)),
  ADD CONSTRAINT "inv_resource_allocations_status_check" CHECK (status IN ('HELD', 'CONFIRMED', 'RELEASED')),
  ADD CONSTRAINT "inv_resource_allocations_hold_check" CHECK (status <> 'HELD' OR hold_expires_at IS NOT NULL),
  ADD CONSTRAINT "inv_resource_allocations_resource_fkey"
    FOREIGN KEY (tenant_id, trip_resource_id) REFERENCES inv_trip_resources (tenant_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "inv_resource_allocations_no_overlap"
    EXCLUDE USING gist (trip_resource_id WITH =, stop_range WITH &&) WHERE (status <> 'RELEASED');

-- Camarote → camas: FK compuesta con columna opcional (MATCH SIMPLE: NULL = sin padre).
ALTER TABLE "inv_trip_resources"
  ADD CONSTRAINT "inv_trip_resources_parent_fkey"
    FOREIGN KEY (tenant_id, parent_id) REFERENCES inv_trip_resources (tenant_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Capacidades agregadas: el contador nunca supera la capacidad (red de seguridad final).
ALTER TABLE "inv_pool_segment_usage"
  ADD CONSTRAINT "inv_pool_segment_usage_within_capacity" CHECK (used >= 0 AND used <= capacity),
  ADD CONSTRAINT "inv_pool_segment_usage_pool_fkey"
    FOREIGN KEY (tenant_id, pool_id) REFERENCES inv_pools (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "inv_pool_allocations"
  ADD CONSTRAINT "inv_pool_allocations_range_not_empty" CHECK (NOT isempty(stop_range)),
  ADD CONSTRAINT "inv_pool_allocations_quantity_positive" CHECK (quantity > 0),
  ADD CONSTRAINT "inv_pool_allocations_status_check" CHECK (status IN ('HELD', 'CONFIRMED', 'RELEASED')),
  ADD CONSTRAINT "inv_pool_allocations_pool_fkey"
    FOREIGN KEY (tenant_id, pool_id) REFERENCES inv_pools (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ============================================================================
-- RLS en todas las tablas de tenant (ADR-003)
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inv_trips','inv_trip_resources','inv_resource_allocations','inv_pools','inv_pool_segment_usage','inv_pool_allocations']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)$p$, t);
  END LOOP;
END $$;
