-- Fase 7.E1 · Equipamiento de unidades e inspecciones preoperacionales (plan-equipamiento-inspecciones, EQ-Q1 a EQ-Q10,
-- aprobadas el 2026-11-19). Herramienta OPCIONAL de control interno: ningún flujo de viajes, venta, asignación ni salida
-- depende de estas tablas, y no equivale a una certificación ni autorización del MTC o la DICAPI.
--   equipment_catalog 🌐: sugerencias de YEBO (terrestre, fluvial o general), con una referencia normativa ORIENTATIVA.
--     No es una lista de obligatorios: lo exigible depende del servicio, la categoría, el arqueo y la norma vigente.
--   tenant_equipment_items: catálogo propio de cada empresa (RLS). Se archiva, no se borra.
--   vehicle_equipment: lo que declara cada unidad, con sus propios datos. «Eliminar» = archivar (EQ-Q6).
--   vehicle_inspections, vehicle_inspection_items y vehicle_inspection_evidence: borrador editable; completada,
--     inmutable (trigger), con la copia de la unidad y de cada elemento. Una corrección es una rectificación: otra
--     inspección que apunta a la original (EQ-Q4). El viaje es opcional y debe ser de la misma unidad.
--   file_assets: tipo nuevo INSPECTION_EVIDENCE (privado, JPEG, hasta 5 MB).
--   Permisos equipment.manage, inspections.perform e inspections.read (plantilla Administrador; EQ-Q9).
--
-- Reversión (como yebo_owner; se pierden el equipamiento y las inspecciones):
--   DROP TABLE "vehicle_inspection_evidence", "vehicle_inspection_items", "vehicle_inspections", "vehicle_equipment",
--     "tenant_equipment_items", "equipment_catalog";
--   DROP FUNCTION "inspections_guard"(), "inspection_children_guard"();
--   DROP TYPE "equipment_category", "equipment_status", "inspection_status", "inspection_result";
--   DELETE FROM "file_assets" WHERE kind::text = 'INSPECTION_EVIDENCE';  -- y sus objetos en el almacenamiento
--   -- file_assets_kind_rules: volver a la versión de la 20261113020000_fase6_2_fleet. El valor INSPECTION_EVIDENCE
--   -- del enum file_asset_kind no se puede quitar sin recrear el tipo; queda sin uso.
--   -- Permisos: quitarlos de role_permissions (tenant a tenant), de la plantilla ADMIN y de permissions.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261123010000_fase7_e1_equipment_inspections';

-- CreateEnum
CREATE TYPE "equipment_category" AS ENUM ('SAFETY', 'EMERGENCY', 'OPERATION');

-- CreateEnum
CREATE TYPE "equipment_status" AS ENUM ('OPERATIVE', 'DETERIORATED', 'INOPERATIVE', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "inspection_status" AS ENUM ('DRAFT', 'COMPLETED', 'COMPLETED_WITH_OBSERVATIONS');

-- CreateEnum
CREATE TYPE "inspection_result" AS ENUM ('CONFORMING', 'OBSERVED', 'NOT_OPERATIONAL', 'NOT_AVAILABLE');

-- AlterEnum
-- IF NOT EXISTS: el valor no se puede quitar al revertir; así la migración se puede volver a aplicar.
ALTER TYPE "file_asset_kind" ADD VALUE IF NOT EXISTS 'INSPECTION_EVIDENCE';

-- CreateTable
CREATE TABLE "equipment_catalog" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "modality" "service_modality",
    "category" "equipment_category" NOT NULL,
    "tracks_expiry" BOOLEAN NOT NULL,
    "tracks_serial" BOOLEAN NOT NULL,
    "reference" TEXT,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "equipment_catalog_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "tenant_equipment_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "modality" "service_modality",
    "category" "equipment_category" NOT NULL,
    "tracks_expiry" BOOLEAN NOT NULL,
    "tracks_serial" BOOLEAN NOT NULL,
    "description" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_equipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_equipment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "catalog_code" TEXT,
    "tenant_item_id" UUID,
    "name" TEXT NOT NULL,
    "category" "equipment_category" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "description" TEXT,
    "status" "equipment_status" NOT NULL,
    "expires_on" DATE,
    "serial_number" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_inspections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "trip_id" UUID,
    "rectifies_id" UUID,
    "rectification_reason" TEXT,
    "status" "inspection_status" NOT NULL DEFAULT 'DRAFT',
    "vehicle_code" TEXT NOT NULL,
    "vehicle_name" TEXT NOT NULL,
    "vehicle_registration" TEXT NOT NULL,
    "general_notes" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_by_kind" "membership_change_actor" NOT NULL,
    "started_by_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_kind" "membership_change_actor",
    "completed_by_id" UUID,
    "conforming_count" INTEGER,
    "observed_count" INTEGER,
    "not_operational_count" INTEGER,
    "not_available_count" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_inspection_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "vehicle_equipment_id" UUID,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "category" "equipment_category" NOT NULL,
    "declared_quantity" INTEGER NOT NULL,
    "declared_status" "equipment_status" NOT NULL,
    "serial_number" TEXT,
    "expires_on" DATE,
    "result" "inspection_result",
    "found_quantity" INTEGER,
    "observation" TEXT,

    CONSTRAINT "vehicle_inspection_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_inspection_evidence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "item_id" UUID,
    "file_asset_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_inspection_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_equipment_items_tenant_id_idx" ON "tenant_equipment_items"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_equipment_items_tenant_id_id_key" ON "tenant_equipment_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "vehicle_equipment_tenant_id_vehicle_id_idx" ON "vehicle_equipment"("tenant_id", "vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_equipment_tenant_id_tenant_item_id_idx" ON "vehicle_equipment"("tenant_id", "tenant_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_equipment_tenant_id_id_key" ON "vehicle_equipment"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "vehicle_inspections_tenant_id_vehicle_id_started_at_idx" ON "vehicle_inspections"("tenant_id", "vehicle_id", "started_at");

-- CreateIndex
CREATE INDEX "vehicle_inspections_tenant_id_trip_id_idx" ON "vehicle_inspections"("tenant_id", "trip_id");

-- CreateIndex
CREATE INDEX "vehicle_inspections_tenant_id_rectifies_id_idx" ON "vehicle_inspections"("tenant_id", "rectifies_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_inspections_tenant_id_id_key" ON "vehicle_inspections"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "vehicle_inspection_items_tenant_id_inspection_id_idx" ON "vehicle_inspection_items"("tenant_id", "inspection_id");

-- CreateIndex
CREATE INDEX "vehicle_inspection_items_tenant_id_vehicle_equipment_id_idx" ON "vehicle_inspection_items"("tenant_id", "vehicle_equipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_inspection_items_tenant_id_id_key" ON "vehicle_inspection_items"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_inspection_items_inspection_id_seq_key" ON "vehicle_inspection_items"("inspection_id", "seq");

-- CreateIndex
CREATE INDEX "vehicle_inspection_evidence_tenant_id_inspection_id_idx" ON "vehicle_inspection_evidence"("tenant_id", "inspection_id");

-- CreateIndex
CREATE INDEX "vehicle_inspection_evidence_tenant_id_item_id_idx" ON "vehicle_inspection_evidence"("tenant_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_inspection_evidence_tenant_id_id_key" ON "vehicle_inspection_evidence"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_inspection_evidence_tenant_id_file_asset_id_key" ON "vehicle_inspection_evidence"("tenant_id", "file_asset_id");

-- AddForeignKey
ALTER TABLE "tenant_equipment_items" ADD CONSTRAINT "tenant_equipment_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_equipment" ADD CONSTRAINT "vehicle_equipment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_equipment" ADD CONSTRAINT "vehicle_equipment_tenant_id_vehicle_id_fkey" FOREIGN KEY ("tenant_id", "vehicle_id") REFERENCES "vehicles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_equipment" ADD CONSTRAINT "vehicle_equipment_catalog_code_fkey" FOREIGN KEY ("catalog_code") REFERENCES "equipment_catalog"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_equipment" ADD CONSTRAINT "vehicle_equipment_tenant_id_tenant_item_id_fkey" FOREIGN KEY ("tenant_id", "tenant_item_id") REFERENCES "tenant_equipment_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_tenant_id_vehicle_id_fkey" FOREIGN KEY ("tenant_id", "vehicle_id") REFERENCES "vehicles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_tenant_id_trip_id_fkey" FOREIGN KEY ("tenant_id", "trip_id") REFERENCES "trips"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_tenant_id_rectifies_id_fkey" FOREIGN KEY ("tenant_id", "rectifies_id") REFERENCES "vehicle_inspections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_inspection_items" ADD CONSTRAINT "vehicle_inspection_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_inspection_items" ADD CONSTRAINT "vehicle_inspection_items_tenant_id_inspection_id_fkey" FOREIGN KEY ("tenant_id", "inspection_id") REFERENCES "vehicle_inspections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_inspection_items" ADD CONSTRAINT "vehicle_inspection_items_tenant_id_vehicle_equipment_id_fkey" FOREIGN KEY ("tenant_id", "vehicle_equipment_id") REFERENCES "vehicle_equipment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_inspection_evidence" ADD CONSTRAINT "vehicle_inspection_evidence_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_inspection_evidence" ADD CONSTRAINT "vehicle_inspection_evidence_tenant_id_inspection_id_fkey" FOREIGN KEY ("tenant_id", "inspection_id") REFERENCES "vehicle_inspections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_inspection_evidence" ADD CONSTRAINT "vehicle_inspection_evidence_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "vehicle_inspection_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_inspection_evidence" ADD CONSTRAINT "vehicle_inspection_evidence_tenant_id_file_asset_id_fkey" FOREIGN KEY ("tenant_id", "file_asset_id") REFERENCES "file_assets"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- ============================================================================
-- Catálogo de sugerencias (orientativo; textos validados con el responsable antes de aplicar a yebo_dev)
-- ============================================================================
ALTER TABLE "equipment_catalog"
  ADD CONSTRAINT "equipment_catalog_code" CHECK ("code" ~ '^[A-Z][A-Z_]{1,23}$');

INSERT INTO "equipment_catalog" ("code", "name", "modality", "category", "tracks_expiry", "tracks_serial", "reference", "sort_order") VALUES
  ('BOTIQUIN', 'Botiquín de primeros auxilios', NULL, 'EMERGENCY', true, false,
   'Referencia orientativa. Terrestre: RD 367-2010-MTC/15. Fluvial: RD 970-2022-MGP/DICAPI (RESEP-FLUVIAL).', 10),
  ('EXTINTOR', 'Extintor', NULL, 'SAFETY', true, true,
   'Referencia orientativa. Terrestre: DS 017-2009-MTC. Fluvial: RD 970-2022-MGP/DICAPI (RESEP-FLUVIAL).', 20),
  ('GPS', 'GPS o sistema de localización', NULL, 'OPERATION', false, true, NULL, 30),
  ('LINTERNA', 'Linterna', NULL, 'EMERGENCY', false, false, NULL, 40),
  ('NEUMATICO_REPUESTO', 'Neumático de repuesto', 'LAND', 'OPERATION', false, false, NULL, 110),
  ('TRIANGULOS', 'Conos o triángulos de seguridad', 'LAND', 'SAFETY', false, false,
   'Referencia orientativa: DS 017-2009-MTC.', 120),
  ('CINTURONES', 'Cinturones de seguridad', 'LAND', 'SAFETY', false, false,
   'Referencia orientativa: DS 017-2009-MTC.', 130),
  ('HERRAMIENTAS', 'Herramientas de emergencia', 'LAND', 'EMERGENCY', false, false, NULL, 140),
  ('MARTILLO', 'Martillo rompevidrios', 'LAND', 'EMERGENCY', false, false, NULL, 150),
  ('CHALECO_SALVAVIDAS', 'Chalecos salvavidas', 'RIVER', 'SAFETY', true, false,
   'Referencia orientativa: RD 970-2022-MGP/DICAPI (RESEP-FLUVIAL) y DS 014-2006-MTC.', 210),
  ('CHALECO_INFANTIL', 'Chalecos salvavidas infantiles', 'RIVER', 'SAFETY', true, false,
   'Referencia orientativa: RD 970-2022-MGP/DICAPI (RESEP-FLUVIAL).', 220),
  ('ARO_SALVAVIDAS', 'Aros salvavidas', 'RIVER', 'SAFETY', false, false,
   'Referencia orientativa: RD 970-2022-MGP/DICAPI (RESEP-FLUVIAL).', 230),
  ('RADIO', 'Equipo de comunicación (radio)', 'RIVER', 'OPERATION', false, true, NULL, 240),
  ('ACHIQUE', 'Equipo de achique', 'RIVER', 'EMERGENCY', false, false, NULL, 250),
  ('LUCES_NAVEGACION', 'Luces de navegación', 'RIVER', 'OPERATION', false, false,
   'Referencia orientativa: RD 970-2022-MGP/DICAPI (RESEP-FLUVIAL).', 260),
  ('BENGALAS', 'Señales pirotécnicas (bengalas)', 'RIVER', 'EMERGENCY', true, false, NULL, 270);

-- ============================================================================
-- Reglas de cada fila
-- ============================================================================
ALTER TABLE "tenant_equipment_items"
  ADD CONSTRAINT "tenant_equipment_items_name" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 2 AND 80),
  ADD CONSTRAINT "tenant_equipment_items_description" CHECK (
    "description" IS NULL OR ("description" = btrim("description") AND char_length("description") BETWEEN 1 AND 300));
-- Un nombre activo por empresa (sin distinguir mayúsculas).
CREATE UNIQUE INDEX "tenant_equipment_items_name_key" ON "tenant_equipment_items" ("tenant_id", lower("name"))
  WHERE "archived_at" IS NULL;

ALTER TABLE "vehicle_equipment"
  ADD CONSTRAINT "vehicle_equipment_name" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 2 AND 80),
  ADD CONSTRAINT "vehicle_equipment_quantity" CHECK ("quantity" BETWEEN 1 AND 100000),
  ADD CONSTRAINT "vehicle_equipment_text" CHECK (
    ("description" IS NULL OR ("description" = btrim("description") AND char_length("description") BETWEEN 1 AND 300))
    AND ("serial_number" IS NULL OR ("serial_number" = btrim("serial_number") AND char_length("serial_number") BETWEEN 1 AND 60))),
  ADD CONSTRAINT "vehicle_equipment_origin" CHECK ("catalog_code" IS NULL OR "tenant_item_id" IS NULL);

ALTER TABLE "vehicle_inspections"
  ADD CONSTRAINT "vehicle_inspections_rectification" CHECK (
    ("rectifies_id" IS NULL) = ("rectification_reason" IS NULL)
    AND ("rectification_reason" IS NULL OR ("rectification_reason" = btrim("rectification_reason")
         AND char_length("rectification_reason") BETWEEN 3 AND 300))
    AND ("rectifies_id" IS NULL OR "rectifies_id" <> "id")),
  ADD CONSTRAINT "vehicle_inspections_notes" CHECK ("general_notes" IS NULL OR char_length("general_notes") BETWEEN 1 AND 2000),
  ADD CONSTRAINT "vehicle_inspections_completed" CHECK (
    ("status" = 'DRAFT') = ("completed_at" IS NULL)
    AND ("completed_at" IS NULL) = ("completed_by_kind" IS NULL)
    AND ("completed_by_kind" IS NULL) = ("completed_by_id" IS NULL)
    AND ("status" = 'DRAFT') = ("conforming_count" IS NULL)
    AND ("conforming_count" IS NULL) = ("observed_count" IS NULL)
    AND ("observed_count" IS NULL) = ("not_operational_count" IS NULL)
    AND ("not_operational_count" IS NULL) = ("not_available_count" IS NULL)),
  ADD CONSTRAINT "vehicle_inspections_actors" CHECK (
    "started_by_kind" IN ('MEMBERSHIP', 'PLATFORM_USER')
    AND ("completed_by_kind" IS NULL OR "completed_by_kind" IN ('MEMBERSHIP', 'PLATFORM_USER')));

ALTER TABLE "vehicle_inspection_items"
  ADD CONSTRAINT "vehicle_inspection_items_seq" CHECK ("seq" BETWEEN 0 AND 999),
  ADD CONSTRAINT "vehicle_inspection_items_values" CHECK (
    char_length("name") BETWEEN 2 AND 80 AND "declared_quantity" BETWEEN 1 AND 100000
    AND ("found_quantity" IS NULL OR "found_quantity" BETWEEN 0 AND 100000)
    AND ("observation" IS NULL OR char_length("observation") BETWEEN 1 AND 500));

-- file_assets: las fotos de evidencia son privadas, JPEG recodificado, hasta 5 MB (el valor nuevo del enum no se puede
-- usar en esta transacción, así que se compara como texto, como en la 6.2).
ALTER TABLE "file_assets" DROP CONSTRAINT "file_assets_kind_rules";
ALTER TABLE "file_assets"
  ADD CONSTRAINT "file_assets_kind_rules" CHECK (CASE "kind"::text
    WHEN 'VEHICLE_DOCUMENT' THEN "visibility" = 'PRIVATE' AND "mime" IN ('application/pdf', 'image/jpeg', 'image/png')
    WHEN 'INSPECTION_EVIDENCE' THEN "visibility" = 'PRIVATE' AND "mime" = 'image/jpeg' AND "size_bytes" <= 5242880
    ELSE "visibility" = 'PUBLIC' AND "mime" <> 'application/pdf' AND "size_bytes" <= 5242880 END);

-- ============================================================================
-- Inspecciones: nacen en borrador; el viaje es de la misma unidad; la rectificación, de una completada de la misma
-- unidad; completar exige todos los resultados y los conteos exactos; completada no cambia ni se borra.
-- ============================================================================
CREATE FUNCTION "inspections_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
  st inspection_status;
  n int; pending int; c1 int; c2 int; c3 int; c4 int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'vehicle_inspections: una inspección completada no se borra' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'vehicle_inspections: una inspección nace en borrador' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.trip_id IS NOT NULL THEN
      SELECT vehicle_id INTO v FROM "trips" WHERE id = NEW.trip_id;
      IF v IS DISTINCT FROM NEW.vehicle_id THEN
        RAISE EXCEPTION 'vehicle_inspections: el viaje no es de esa unidad' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF NEW.rectifies_id IS NOT NULL THEN
      SELECT vehicle_id, status INTO v, st FROM "vehicle_inspections" WHERE id = NEW.rectifies_id;
      IF v IS DISTINCT FROM NEW.vehicle_id OR st IS NULL OR st = 'DRAFT' THEN
        RAISE EXCEPTION 'vehicle_inspections: solo se rectifica una inspección completada de la misma unidad'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'vehicle_inspections: una inspección completada no cambia' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status <> 'DRAFT' THEN
    SELECT count(*), count(*) FILTER (WHERE result IS NULL),
           count(*) FILTER (WHERE result = 'CONFORMING'), count(*) FILTER (WHERE result = 'OBSERVED'),
           count(*) FILTER (WHERE result = 'NOT_OPERATIONAL'), count(*) FILTER (WHERE result = 'NOT_AVAILABLE')
      INTO n, pending, c1, c2, c3, c4
      FROM "vehicle_inspection_items" WHERE inspection_id = NEW.id;
    IF n = 0 OR pending > 0 THEN
      RAISE EXCEPTION 'vehicle_inspections: para completar, cada elemento tiene su resultado' USING ERRCODE = 'P0001';
    END IF;
    IF (NEW.conforming_count, NEW.observed_count, NEW.not_operational_count, NEW.not_available_count)
       IS DISTINCT FROM (c1, c2, c3, c4)
       OR (NEW.status = 'COMPLETED') <> (c1 = n) THEN
      RAISE EXCEPTION 'vehicle_inspections: los conteos y el resultado general no coinciden con los elementos'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "vehicle_inspections_guard" BEFORE INSERT OR UPDATE OR DELETE ON "vehicle_inspections"
  FOR EACH ROW EXECUTE FUNCTION "inspections_guard"();

-- Elementos y fotos: solo con la inspección en borrador; la foto de un elemento, de esa misma inspección.
CREATE FUNCTION "inspection_children_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i_id uuid;
  st inspection_status;
  owner uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN i_id := OLD.inspection_id; ELSE i_id := NEW.inspection_id; END IF;
  SELECT status INTO st FROM "vehicle_inspections" WHERE id = i_id;
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION '%: una inspección completada no cambia', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  -- IF anidados (no AND): PL/pgSQL resuelve NEW.item_id aunque la condición anterior sea falsa, y solo la tabla de fotos
  -- tiene esa columna.
  IF TG_TABLE_NAME = 'vehicle_inspection_evidence' AND TG_OP = 'INSERT' THEN
    IF NEW.item_id IS NOT NULL THEN
      SELECT inspection_id INTO owner FROM "vehicle_inspection_items" WHERE id = NEW.item_id;
      IF owner IS DISTINCT FROM NEW.inspection_id THEN
        RAISE EXCEPTION 'vehicle_inspection_evidence: el elemento es de otra inspección' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "vehicle_inspection_items_guard" BEFORE INSERT OR UPDATE OR DELETE ON "vehicle_inspection_items"
  FOR EACH ROW EXECUTE FUNCTION "inspection_children_guard"();
CREATE TRIGGER "vehicle_inspection_evidence_guard" BEFORE INSERT OR UPDATE OR DELETE ON "vehicle_inspection_evidence"
  FOR EACH ROW EXECUTE FUNCTION "inspection_children_guard"();

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025)
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_equipment_items', 'vehicle_equipment', 'vehicle_inspections',
                           'vehicle_inspection_items', 'vehicle_inspection_evidence'] LOOP
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
GRANT SELECT ON "equipment_catalog" TO yebo_app, yebo_backoffice;
GRANT SELECT, INSERT ON "tenant_equipment_items", "vehicle_equipment" TO yebo_app;
GRANT UPDATE ("name", "modality", "category", "tracks_expiry", "tracks_serial", "description", "archived_at", "updated_at")
  ON "tenant_equipment_items" TO yebo_app;
-- La unidad y el origen del elemento no cambian; sin DELETE (se archiva).
GRANT UPDATE ("name", "category", "quantity", "description", "status", "expires_on", "serial_number", "archived_at",
              "updated_at") ON "vehicle_equipment" TO yebo_app;
-- Inspecciones: la unidad, el viaje, la rectificación, la copia y el inicio no cambian. DELETE solo de borradores
-- (trigger), con sus elementos y fotos.
GRANT SELECT, INSERT, DELETE ON "vehicle_inspections", "vehicle_inspection_items", "vehicle_inspection_evidence"
  TO yebo_app;
GRANT UPDATE ("status", "general_notes", "completed_at", "completed_by_kind", "completed_by_id", "conforming_count",
              "observed_count", "not_operational_count", "not_available_count", "updated_at")
  ON "vehicle_inspections" TO yebo_app;
GRANT UPDATE ("result", "found_quantity", "observation") ON "vehicle_inspection_items" TO yebo_app;
GRANT SELECT ON "tenant_equipment_items", "vehicle_equipment", "vehicle_inspections", "vehicle_inspection_items",
  "vehicle_inspection_evidence" TO yebo_backoffice;

-- ============================================================================
-- Permisos (fuente: permission-catalog.ts; EQ-Q9)
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'equipment.manage', 'FLEET', 'Declarar el equipamiento de las unidades y su catálogo propio', false, now()),
  (gen_random_uuid(), 'inspections.perform', 'FLEET', 'Realizar, completar y rectificar inspecciones preoperacionales', false, now()),
  (gen_random_uuid(), 'inspections.read', 'FLEET', 'Ver el equipamiento y las inspecciones de las unidades', false, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates"
   SET "permission_codes" = "permission_codes" || ARRAY(
         SELECT c FROM unnest(ARRAY['equipment.manage', 'inspections.perform', 'inspections.read']) c
          WHERE NOT (c = ANY ("permission_codes"))),
       "updated_at" = now()
 WHERE "code" = 'ADMIN';

DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
      SELECT r.tenant_id, r.id, p.id
        FROM "roles" r JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
        CROSS JOIN "permissions" p
       WHERE p.code IN ('equipment.manage', 'inspections.perform', 'inspections.read')
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
