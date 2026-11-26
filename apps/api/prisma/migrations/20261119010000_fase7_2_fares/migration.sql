-- Fase 7.2 · Tarifas (data-dictionary §5; plan de la Fase 7, F7-Q1, aprobada el 2026-11-18; ADR-010).
--   fares: de tenant, con RLS forzado. Precio de un par origen → destino (ubicaciones) de una ruta, por servicio
--   (PASSENGER o VEHICLE_TRANSPORT; encomiendas y carga tienen su tarifario en las fases 9 y 10: por peso, volumen o
--   ambos, según decida la empresa) y clase de precio, en soles, con vigencia [valid_from, valid_to) en fechas de la empresa (como vehicle_layout_assignments).
--   Una tarifa no se edita: yebo_app solo puede cambiar su fin (valid_to) y anularla (status, cancelled_at). Un cambio
--   de precio es otra tarifa; la anterior termina ese día. Anulada es definitivo (trigger). Sin DELETE.
--   Sin solapamientos entre tarifas activas de la misma clave (ruta, par, servicio y clase): EXCLUDE con btree_gist.
--   Que el par sea de la ruta (subir en el origen y bajar después en el destino) lo comprueba la API: las paradas
--   cambian al editar la ruta y la tarifa sigue existiendo (la API la marca fuera de la ruta).
--   Sin channel_kind (precio por canal): llega con la venta (Fase 8; F7-Q1).
--   Permiso fares.manage (plantilla Administrador).
--
-- Reversión (como yebo_owner; se pierden las tarifas):
--   DROP TABLE "fares"; DROP FUNCTION "fares_guard"(); DROP TYPE "fare_status";
--   -- Permiso fares.manage: quitarlo de role_permissions (tenant a tenant), de la plantilla ADMIN y de permissions.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261119010000_fase7_2_fares';

-- CreateEnum
CREATE TYPE "fare_status" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateTable
CREATE TABLE "fares" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "service" "transport_service" NOT NULL,
    "price_class_code" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "amount" DECIMAL(7,2) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "status" "fare_status" NOT NULL DEFAULT 'ACTIVE',
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fares_tenant_id_route_id_origin_location_id_destination_loc_idx" ON "fares"("tenant_id", "route_id", "origin_location_id", "destination_location_id", "price_class_code", "valid_from");

-- CreateIndex
CREATE INDEX "fares_tenant_id_origin_location_id_idx" ON "fares"("tenant_id", "origin_location_id");

-- CreateIndex
CREATE INDEX "fares_tenant_id_destination_location_id_idx" ON "fares"("tenant_id", "destination_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "fares_tenant_id_id_key" ON "fares"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "fares" ADD CONSTRAINT "fares_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fares" ADD CONSTRAINT "fares_tenant_id_route_id_fkey" FOREIGN KEY ("tenant_id", "route_id") REFERENCES "routes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fares" ADD CONSTRAINT "fares_tenant_id_origin_location_id_fkey" FOREIGN KEY ("tenant_id", "origin_location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fares" ADD CONSTRAINT "fares_tenant_id_destination_location_id_fkey" FOREIGN KEY ("tenant_id", "destination_location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- ============================================================================
-- Reglas de cada fila
-- ============================================================================
ALTER TABLE "fares"
  ADD CONSTRAINT "fares_service" CHECK ("service" IN ('PASSENGER', 'VEHICLE_TRANSPORT')),
  ADD CONSTRAINT "fares_price_class" CHECK ("price_class_code" ~ '^[A-Z][A-Z0-9_]{1,23}$'),
  ADD CONSTRAINT "fares_currency" CHECK ("currency" = 'PEN'),
  -- Hasta S/ 99 999,99 por la precisión de la columna (contratos: FARE_MAX_AMOUNT).
  ADD CONSTRAINT "fares_amount" CHECK ("amount" > 0),
  ADD CONSTRAINT "fares_pair" CHECK ("origin_location_id" <> "destination_location_id"),
  ADD CONSTRAINT "fares_dates" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from"),
  ADD CONSTRAINT "fares_cancelled" CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)),
  -- Una clave, un precio por día: los rangos [desde, hasta) de las tarifas activas no se solapan.
  ADD CONSTRAINT "fares_no_overlap" EXCLUDE USING gist (
    "tenant_id" WITH =, "route_id" WITH =, "origin_location_id" WITH =, "destination_location_id" WITH =,
    "service" WITH =, "price_class_code" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&)
    WHERE ("status" = 'ACTIVE');

-- El monto, la clave y el inicio no cambian (privilegios por columna); una tarifa anulada ya no cambia.
CREATE FUNCTION "fares_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'fares: una tarifa anulada no cambia' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "fares_guard" BEFORE UPDATE ON "fares" FOR EACH ROW EXECUTE FUNCTION "fares_guard"();

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025)
-- ============================================================================
ALTER TABLE "fares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fares" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "fares"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============================================================================
-- Privilegios (ADR-034)
-- ============================================================================
-- yebo_app: crea tarifas, les pone fin y las anula; no cambia su monto, su clave ni su inicio, ni las borra.
GRANT SELECT, INSERT ON "fares" TO yebo_app;
GRANT UPDATE ("valid_to", "status", "cancelled_at", "updated_at") ON "fares" TO yebo_app;
-- yebo_backoffice: el panel de YEBO las ve.
GRANT SELECT ON "fares" TO yebo_backoffice;

-- ============================================================================
-- Permiso fares.manage (fuente: permission-catalog.ts)
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'fares.manage', 'FARES', 'Gestionar las tarifas de las rutas', false, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates" SET "permission_codes" = "permission_codes" || ARRAY['fares.manage']::text[],
       "updated_at" = now()
 WHERE "code" = 'ADMIN' AND NOT ('fares.manage' = ANY ("permission_codes"));

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
       WHERE p.code = 'fares.manage'
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
