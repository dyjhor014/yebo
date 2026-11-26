-- Fase 6.3 · Layouts de los vehículos (data-dictionary §4; capacity-and-inventory §2–4; decisión F6-Q1 del
-- responsable, 2026-11-10; auditoría T4: grilla con elementos posicionados).
--   vehicle_layouts: el layout (nombre, modalidad, tipo de vehículo opcional con la misma modalidad por FK).
--   layout_versions: el borrador es un documento JSON (LayoutDocumentSchema, validado en la API); al publicar se
--   materializa en layout_zones, layout_elements y capacity_rules y la versión ya no cambia (trigger). Un borrador
--   como mucho por layout (draft_slot); varias publicadas (los viajes de la Fase 7 referenciarán la suya).
--   layout_zones / layout_elements / capacity_rules: solo se insertan mientras su versión es borrador (es decir, al
--   publicarla); yebo_app no tiene UPDATE ni DELETE.
--   vehicle_layout_assignments: versión PUBLICADA asignada a un vehículo en [valid_from, valid_to), sin solapamiento
--   por vehículo (EXCLUDE con btree_gist). Se termina con valid_to; no se borra.
--   Permiso layouts.manage (plantilla Administrador).
--
-- Reversión (como yebo_owner; se pierden los layouts y sus asignaciones):
--   DROP TABLE "vehicle_layout_assignments", "capacity_rules", "layout_elements", "layout_zones", "layout_versions",
--              "vehicle_layouts";
--   DROP FUNCTION "layout_versions_guard"(), "layout_children_guard"(), "vehicle_layout_assignments_guard"();
--   DROP TYPE "layout_version_status", "zone_kind", "allocation_mode", "layout_element_kind", "capacity_dimension";
--   -- Permiso layouts.manage: quitarlo de role_permissions (tenant a tenant), de la plantilla ADMIN y de permissions.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261113030000_fase6_3_layouts';

-- CreateEnum
CREATE TYPE "layout_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "zone_kind" AS ENUM ('SEATING', 'VIP', 'CABINS', 'FREE_ZONE', 'HAMMOCK', 'LUGGAGE', 'HOLD', 'CARGO_DECK', 'VEHICLE_DECK');

-- CreateEnum
CREATE TYPE "allocation_mode" AS ENUM ('ASSIGNED', 'POOLED');

-- CreateEnum
CREATE TYPE "layout_element_kind" AS ENUM ('SEAT', 'BED', 'CABIN', 'VEHICLE_SLOT', 'AISLE', 'STAIRS', 'DOOR', 'WC', 'LABEL', 'OTHER');

-- CreateEnum
CREATE TYPE "capacity_dimension" AS ENUM ('PERSONS', 'UNITS', 'WEIGHT_KG', 'VOLUME_M3', 'LINEAR_M');

-- CreateTable
CREATE TABLE "vehicle_layouts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "modality" "service_modality" NOT NULL,
    "vehicle_type_id" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "layout_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "layout_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "layout_version_status" NOT NULL,
    "draft_slot" BOOLEAN,
    "schema_version" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "decks" INTEGER NOT NULL,
    "canvas" JSONB NOT NULL,
    "total_persons" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by_kind" "membership_change_actor",
    "published_by_id" UUID,

    CONSTRAINT "layout_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "layout_zones" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "layout_version_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "zone_kind" NOT NULL,
    "service" "transport_service" NOT NULL,
    "allocation_mode" "allocation_mode" NOT NULL,
    "deck" INTEGER NOT NULL,
    "geometry" JSONB NOT NULL,
    "price_class_code" TEXT,
    "constraints" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "layout_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "layout_elements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "layout_version_id" UUID NOT NULL,
    "zone_id" UUID,
    "parent_element_id" UUID,
    "kind" "layout_element_kind" NOT NULL,
    "code" TEXT NOT NULL,
    "is_assignable" BOOLEAN NOT NULL,
    "sellable_as_unit" BOOLEAN NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "w" INTEGER NOT NULL,
    "h" INTEGER NOT NULL,
    "rotation" INTEGER NOT NULL,
    "deck" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "price_class_code" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "layout_elements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "dimension" "capacity_dimension" NOT NULL,
    "capacity" DECIMAL(14,3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capacity_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_layout_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "layout_version_id" UUID NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_layout_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_layouts_tenant_id_id_key" ON "vehicle_layouts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_layouts_tenant_id_name_key" ON "vehicle_layouts"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "layout_versions_tenant_id_id_key" ON "layout_versions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "layout_versions_tenant_id_layout_id_version_key" ON "layout_versions"("tenant_id", "layout_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "layout_versions_tenant_id_layout_id_draft_slot_key" ON "layout_versions"("tenant_id", "layout_id", "draft_slot");

-- CreateIndex
CREATE UNIQUE INDEX "layout_zones_tenant_id_id_key" ON "layout_zones"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "layout_zones_tenant_id_layout_version_id_code_key" ON "layout_zones"("tenant_id", "layout_version_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "layout_elements_tenant_id_id_key" ON "layout_elements"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "layout_elements_tenant_id_layout_version_id_code_key" ON "layout_elements"("tenant_id", "layout_version_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "capacity_rules_tenant_id_id_key" ON "capacity_rules"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "capacity_rules_tenant_id_zone_id_dimension_key" ON "capacity_rules"("tenant_id", "zone_id", "dimension");

-- CreateIndex
CREATE INDEX "vehicle_layout_assignments_tenant_id_vehicle_id_idx" ON "vehicle_layout_assignments"("tenant_id", "vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_layout_assignments_tenant_id_layout_version_id_idx" ON "vehicle_layout_assignments"("tenant_id", "layout_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_layout_assignments_tenant_id_id_key" ON "vehicle_layout_assignments"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "vehicle_layouts" ADD CONSTRAINT "vehicle_layouts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_layouts" ADD CONSTRAINT "vehicle_layouts_tenant_id_vehicle_type_id_modality_fkey" FOREIGN KEY ("tenant_id", "vehicle_type_id", "modality") REFERENCES "vehicle_types"("tenant_id", "id", "modality") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "layout_versions" ADD CONSTRAINT "layout_versions_tenant_id_layout_id_fkey" FOREIGN KEY ("tenant_id", "layout_id") REFERENCES "vehicle_layouts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "layout_zones" ADD CONSTRAINT "layout_zones_tenant_id_layout_version_id_fkey" FOREIGN KEY ("tenant_id", "layout_version_id") REFERENCES "layout_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "layout_elements" ADD CONSTRAINT "layout_elements_tenant_id_layout_version_id_fkey" FOREIGN KEY ("tenant_id", "layout_version_id") REFERENCES "layout_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "layout_elements" ADD CONSTRAINT "layout_elements_tenant_id_zone_id_fkey" FOREIGN KEY ("tenant_id", "zone_id") REFERENCES "layout_zones"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "layout_elements" ADD CONSTRAINT "layout_elements_tenant_id_parent_element_id_fkey" FOREIGN KEY ("tenant_id", "parent_element_id") REFERENCES "layout_elements"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "capacity_rules" ADD CONSTRAINT "capacity_rules_tenant_id_zone_id_fkey" FOREIGN KEY ("tenant_id", "zone_id") REFERENCES "layout_zones"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_layout_assignments" ADD CONSTRAINT "vehicle_layout_assignments_tenant_id_vehicle_id_fkey" FOREIGN KEY ("tenant_id", "vehicle_id") REFERENCES "vehicles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_layout_assignments" ADD CONSTRAINT "vehicle_layout_assignments_tenant_id_layout_version_id_fkey" FOREIGN KEY ("tenant_id", "layout_version_id") REFERENCES "layout_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ============================================================================
-- Reglas
-- ============================================================================
ALTER TABLE "vehicle_layouts"
  ADD CONSTRAINT "vehicle_layouts_name" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 2 AND 60);

ALTER TABLE "layout_versions"
  -- draft_slot = TRUE solo en el borrador (UNIQUE por layout: uno como mucho).
  ADD CONSTRAINT "layout_versions_draft_slot" CHECK ("draft_slot" IS NOT DISTINCT FROM
    (CASE WHEN "status" = 'DRAFT' THEN TRUE ELSE NULL END)),
  -- Publicada o archivada ⇔ con fecha y autor (miembro de la empresa o staff con soporte FULL).
  ADD CONSTRAINT "layout_versions_published" CHECK (("status" = 'DRAFT') = ("published_at" IS NULL)
    AND ("published_at" IS NULL) = ("published_by_kind" IS NULL)
    AND ("published_by_kind" IS NULL) = ("published_by_id" IS NULL)
    AND ("published_by_kind" IS NULL OR "published_by_kind" IN ('MEMBERSHIP', 'PLATFORM_USER'))),
  ADD CONSTRAINT "layout_versions_values" CHECK ("version" > 0 AND "schema_version" >= 1
    AND "decks" BETWEEN 1 AND 4 AND ("total_persons" IS NULL OR "total_persons" BETWEEN 1 AND 5000)
    AND jsonb_typeof("document") = 'object' AND pg_column_size("document") <= 1048576
    AND jsonb_typeof("canvas") = 'array');

ALTER TABLE "layout_zones"
  ADD CONSTRAINT "layout_zones_values" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{0,11}$' AND "deck" BETWEEN 0 AND 3
    AND jsonb_typeof("geometry") = 'object');

ALTER TABLE "layout_elements"
  ADD CONSTRAINT "layout_elements_values" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{0,11}$' AND "deck" BETWEEN 0 AND 3
    AND "x" >= 0 AND "y" >= 0 AND "w" >= 1 AND "h" >= 1 AND "rotation" IN (0, 90, 180, 270)
    AND "capacity" BETWEEN 1 AND 12),
  -- Lo asignable es de inventario y está en una zona; un camarote con camas no es asignable (sus camas sí).
  ADD CONSTRAINT "layout_elements_assignable" CHECK (NOT "is_assignable"
    OR ("kind" IN ('SEAT', 'BED', 'CABIN', 'VEHICLE_SLOT') AND "zone_id" IS NOT NULL)),
  ADD CONSTRAINT "layout_elements_parent" CHECK (("parent_element_id" IS NULL) OR ("kind" = 'BED')),
  ADD CONSTRAINT "layout_elements_unit" CHECK (NOT "sellable_as_unit" OR ("kind" = 'CABIN' AND NOT "is_assignable"));

ALTER TABLE "capacity_rules"
  ADD CONSTRAINT "capacity_rules_positive" CHECK ("capacity" > 0);

ALTER TABLE "vehicle_layout_assignments"
  ADD CONSTRAINT "vehicle_layout_assignments_dates" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from"),
  -- Un vehículo, una versión por día: los rangos [desde, hasta) no se solapan.
  ADD CONSTRAINT "vehicle_layout_assignments_no_overlap" EXCLUDE USING gist (
    "tenant_id" WITH =, "vehicle_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);

-- Borrador editable; publicada → solo archivarla; archivada, nada. Sin borrados. Nace como borrador.
CREATE FUNCTION "layout_versions_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'layout_versions: las versiones no se borran' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'layout_versions: una versión nace como borrador' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.layout_id, NEW.version, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.layout_id, OLD.version, OLD.created_at) THEN
    RAISE EXCEPTION 'layout_versions: la identidad de una versión no cambia' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'DRAFT' THEN
    IF NEW.status = 'ARCHIVED' THEN
      RAISE EXCEPTION 'layout_versions: un borrador se publica, no se archiva' USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.status = 'PUBLISHED' THEN
    IF NEW.status <> 'ARCHIVED'
       OR (NEW.document, NEW.schema_version, NEW.decks, NEW.canvas, NEW.total_persons, NEW.published_at,
           NEW.published_by_kind, NEW.published_by_id)
          IS DISTINCT FROM (OLD.document, OLD.schema_version, OLD.decks, OLD.canvas, OLD.total_persons,
                            OLD.published_at, OLD.published_by_kind, OLD.published_by_id) THEN
      RAISE EXCEPTION 'layout_versions: una versión publicada no cambia (solo se archiva)' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'layout_versions: una versión archivada no cambia' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "layout_versions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "layout_versions"
  FOR EACH ROW EXECUTE FUNCTION "layout_versions_guard"();

-- Zonas, elementos y reglas: solo se insertan en una versión que aún es borrador (al publicarla); nunca cambian.
CREATE FUNCTION "layout_children_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status layout_version_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '%: el contenido de una versión de layout no cambia', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'capacity_rules' THEN
    SELECT v.status INTO v_status FROM layout_zones z
      JOIN layout_versions v ON v.tenant_id = z.tenant_id AND v.id = z.layout_version_id
     WHERE z.tenant_id = NEW.tenant_id AND z.id = NEW.zone_id;
  ELSE
    SELECT status INTO v_status FROM layout_versions WHERE tenant_id = NEW.tenant_id AND id = NEW.layout_version_id;
  END IF;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION '%: solo se añade contenido al publicar un borrador', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "layout_zones_guard" BEFORE INSERT OR UPDATE OR DELETE ON "layout_zones"
  FOR EACH ROW EXECUTE FUNCTION "layout_children_guard"();
CREATE TRIGGER "layout_elements_guard" BEFORE INSERT OR UPDATE OR DELETE ON "layout_elements"
  FOR EACH ROW EXECUTE FUNCTION "layout_children_guard"();
CREATE TRIGGER "capacity_rules_guard" BEFORE INSERT OR UPDATE OR DELETE ON "capacity_rules"
  FOR EACH ROW EXECUTE FUNCTION "layout_children_guard"();

-- Asignaciones: solo de versiones publicadas; no se borran; solo cambia el fin (valid_to).
CREATE FUNCTION "vehicle_layout_assignments_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status layout_version_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vehicle_layout_assignments: una asignación se termina, no se borra' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status FROM layout_versions WHERE tenant_id = NEW.tenant_id AND id = NEW.layout_version_id;
    IF v_status IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'vehicle_layout_assignments: solo se asigna una versión publicada' USING ERRCODE = 'P0001';
    END IF;
  ELSIF (NEW.id, NEW.tenant_id, NEW.vehicle_id, NEW.layout_version_id, NEW.valid_from, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.vehicle_id, OLD.layout_version_id, OLD.valid_from, OLD.created_at) THEN
    RAISE EXCEPTION 'vehicle_layout_assignments: solo cambia el fin' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "vehicle_layout_assignments_guard" BEFORE INSERT OR UPDATE OR DELETE ON "vehicle_layout_assignments"
  FOR EACH ROW EXECUTE FUNCTION "vehicle_layout_assignments_guard"();

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025)
-- ============================================================================
ALTER TABLE "vehicle_layouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_layouts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vehicle_layouts"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "layout_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "layout_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "layout_versions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "layout_zones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "layout_zones" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "layout_zones"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "layout_elements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "layout_elements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "layout_elements"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "capacity_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capacity_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "capacity_rules"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "vehicle_layout_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_layout_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vehicle_layout_assignments"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============================================================================
-- Privilegios (ADR-034)
-- ============================================================================
-- yebo_app: sin DELETE. La modalidad de un layout no cambia; el contenido de una versión publicada, tampoco (ni
-- UPDATE ni DELETE en zonas, elementos y reglas); de una asignación solo cambia el fin.
GRANT SELECT, INSERT ON "vehicle_layouts" TO yebo_app;
GRANT UPDATE ("name", "vehicle_type_id", "archived_at", "updated_at") ON "vehicle_layouts" TO yebo_app;
GRANT SELECT, INSERT ON "layout_versions" TO yebo_app;
GRANT UPDATE ("status", "draft_slot", "schema_version", "document", "decks", "canvas", "total_persons", "updated_at",
              "published_at", "published_by_kind", "published_by_id") ON "layout_versions" TO yebo_app;
GRANT SELECT, INSERT ON "layout_zones", "layout_elements", "capacity_rules" TO yebo_app;
GRANT SELECT, INSERT ON "vehicle_layout_assignments" TO yebo_app;
GRANT UPDATE ("valid_to", "updated_at") ON "vehicle_layout_assignments" TO yebo_app;
-- yebo_backoffice: el panel de YEBO los ve.
GRANT SELECT ON "vehicle_layouts", "layout_versions", "layout_zones", "layout_elements", "capacity_rules",
                "vehicle_layout_assignments" TO yebo_backoffice;

-- ============================================================================
-- Permiso layouts.manage (fuente: permission-catalog.ts)
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'layouts.manage', 'LAYOUTS', 'Diseñar, publicar y asignar los layouts de los vehículos', false, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates" SET "permission_codes" = "permission_codes" || ARRAY['layouts.manage']::text[],
       "updated_at" = now()
 WHERE "code" = 'ADMIN' AND NOT ('layouts.manage' = ANY ("permission_codes"));

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
       WHERE p.code = 'layouts.manage'
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
