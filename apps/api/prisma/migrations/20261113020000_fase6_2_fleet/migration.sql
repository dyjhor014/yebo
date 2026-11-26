-- Fase 6.2 · Flota (data-dictionary §4; decisiones F6-Q3 y F6-Q5 del responsable, 2026-11-10).
--   vehicle_type_catalog 🌐 y vehicle_document_types 🌐: catálogos globales (sugerencias de tipos; SOAT, revisión
--   técnica, certificados…).
--   vehicle_types, vehicles, vehicle_documents: de tenant, con RLS forzado. El vehículo hereda la modalidad de su
--   tipo por FK compuesta (tenant, tipo, modalidad); la modalidad de un tipo no cambia. El código del vehículo no
--   cambia; la placa o matrícula es única en la empresa. Un vehículo se retira (status RETIRED), no se borra; un
--   documento se archiva. F6-Q3: solo `ownership` (propia o de terceros); sin propietarios ni liquidaciones.
--   file_assets: nuevo tipo VEHICLE_DOCUMENT, siempre PRIVATE; admite PDF (sin dimensiones) y hasta 10 MB. Los
--   archivos del sitio siguen siendo imágenes PUBLIC de hasta 5 MB.
--   Permiso fleet.manage (plantilla Administrador).
--
-- Reversión (como yebo_owner; se pierden la flota y los documentos; antes, borrar del almacenamiento los objetos de
-- los file_assets VEHICLE_DOCUMENT y sus filas):
--   DROP TABLE "vehicle_documents", "vehicles", "vehicle_types", "vehicle_document_types", "vehicle_type_catalog";
--   DROP TYPE "vehicle_status", "vehicle_ownership";
--   DELETE FROM "file_assets" WHERE kind::text = 'VEHICLE_DOCUMENT';
--   ALTER TABLE "file_assets" DROP CONSTRAINT "file_assets_values", DROP CONSTRAINT "file_assets_kind_rules";
--   -- restaurar "file_assets_values" de la migración 20261112020000 y SET NOT NULL en width y height;
--   -- el valor VEHICLE_DOCUMENT del enum file_asset_kind no se puede quitar sin recrear el tipo (se deja).
--   -- Permiso fleet.manage: quitarlo de role_permissions (tenant a tenant), de la plantilla ADMIN y de permissions.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261113020000_fase6_2_fleet';

-- CreateEnum
CREATE TYPE "vehicle_status" AS ENUM ('ACTIVE', 'MAINTENANCE', 'OUT_OF_SERVICE', 'RETIRED');

-- CreateEnum
CREATE TYPE "vehicle_ownership" AS ENUM ('OWN', 'THIRD_PARTY');

-- AlterEnum
ALTER TYPE "file_asset_kind" ADD VALUE 'VEHICLE_DOCUMENT';

-- AlterTable
ALTER TABLE "file_assets" ALTER COLUMN "width" DROP NOT NULL,
ALTER COLUMN "height" DROP NOT NULL;

-- CreateTable
CREATE TABLE "vehicle_type_catalog" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "modality" "service_modality" NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "vehicle_type_catalog_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "vehicle_types" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "modality" "service_modality" NOT NULL,
    "catalog_code" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vehicle_type_id" UUID NOT NULL,
    "modality" "service_modality" NOT NULL,
    "registration_id" TEXT NOT NULL,
    "status" "vehicle_status" NOT NULL DEFAULT 'ACTIVE',
    "ownership" "vehicle_ownership" NOT NULL DEFAULT 'OWN',
    "nominal_capacity" JSONB NOT NULL DEFAULT '{}',
    "features" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_document_types" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "modality" "service_modality",
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "vehicle_document_types_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "vehicle_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "type_code" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issued_on" DATE,
    "expires_on" DATE,
    "file_asset_id" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_types_tenant_id_id_key" ON "vehicle_types"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_types_tenant_id_name_key" ON "vehicle_types"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_types_tenant_id_id_modality_key" ON "vehicle_types"("tenant_id", "id", "modality");

-- CreateIndex
CREATE INDEX "vehicles_tenant_id_vehicle_type_id_idx" ON "vehicles"("tenant_id", "vehicle_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_tenant_id_id_key" ON "vehicles"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_tenant_id_code_key" ON "vehicles"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_tenant_id_registration_id_key" ON "vehicles"("tenant_id", "registration_id");

-- CreateIndex
CREATE INDEX "vehicle_documents_tenant_id_vehicle_id_idx" ON "vehicle_documents"("tenant_id", "vehicle_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_documents_tenant_id_id_key" ON "vehicle_documents"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_documents_tenant_id_file_asset_id_key" ON "vehicle_documents"("tenant_id", "file_asset_id");

-- AddForeignKey
ALTER TABLE "vehicle_types" ADD CONSTRAINT "vehicle_types_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_types" ADD CONSTRAINT "vehicle_types_catalog_code_fkey" FOREIGN KEY ("catalog_code") REFERENCES "vehicle_type_catalog"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenant_id_vehicle_type_id_modality_fkey" FOREIGN KEY ("tenant_id", "vehicle_type_id", "modality") REFERENCES "vehicle_types"("tenant_id", "id", "modality") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_tenant_id_vehicle_id_fkey" FOREIGN KEY ("tenant_id", "vehicle_id") REFERENCES "vehicles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_type_code_fkey" FOREIGN KEY ("type_code") REFERENCES "vehicle_document_types"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_tenant_id_file_asset_id_fkey" FOREIGN KEY ("tenant_id", "file_asset_id") REFERENCES "file_assets"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ============================================================================
-- Reglas
-- ============================================================================
-- file_assets: el valor nuevo del enum no se puede usar en esta misma transacción, así que se compara como texto.
ALTER TABLE "file_assets" DROP CONSTRAINT "file_assets_values";
ALTER TABLE "file_assets"
  ADD CONSTRAINT "file_assets_values" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760
    AND octet_length("checksum_sha256") = 32
    AND ("original_name" IS NULL OR length("original_name") <= 255)
    AND "mime" IN ('image/png', 'image/jpeg', 'image/webp', 'application/pdf')
    -- Una imagen tiene dimensiones; un PDF, no.
    AND (CASE WHEN "mime" = 'application/pdf' THEN "width" IS NULL AND "height" IS NULL
              ELSE "width" BETWEEN 1 AND 8192 AND "height" BETWEEN 1 AND 8192 END)),
  -- Sitio: imágenes PUBLIC de hasta 5 MB (como en la 5.2). Documentos de vehículos: PRIVATE, PDF, JPEG o PNG.
  ADD CONSTRAINT "file_assets_kind_rules" CHECK (CASE "kind"::text
    WHEN 'VEHICLE_DOCUMENT' THEN "visibility" = 'PRIVATE' AND "mime" IN ('application/pdf', 'image/jpeg', 'image/png')
    ELSE "visibility" = 'PUBLIC' AND "mime" <> 'application/pdf' AND "size_bytes" <= 5242880 END);

ALTER TABLE "vehicle_type_catalog" ADD CONSTRAINT "vehicle_type_catalog_code" CHECK ("code" ~ '^[A-Z][A-Z_]{1,23}$');
ALTER TABLE "vehicle_document_types" ADD CONSTRAINT "vehicle_document_types_code" CHECK ("code" ~ '^[A-Z][A-Z_]{1,23}$');

ALTER TABLE "vehicle_types"
  ADD CONSTRAINT "vehicle_types_name" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 2 AND 60);

ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_code" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  ADD CONSTRAINT "vehicles_registration" CHECK ("registration_id" ~ '^[A-Z0-9][A-Z0-9 -]{2,19}$'),
  ADD CONSTRAINT "vehicles_text" CHECK (char_length("name") BETWEEN 2 AND 80),
  ADD CONSTRAINT "vehicles_json" CHECK (jsonb_typeof("nominal_capacity") = 'object'
    AND jsonb_typeof("features") = 'array' AND jsonb_array_length("features") <= 20);

ALTER TABLE "vehicle_documents"
  ADD CONSTRAINT "vehicle_documents_number" CHECK (char_length("number") BETWEEN 1 AND 40),
  ADD CONSTRAINT "vehicle_documents_dates" CHECK ("issued_on" IS NULL OR "expires_on" IS NULL OR "expires_on" >= "issued_on");

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025)
-- ============================================================================
ALTER TABLE "vehicle_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_types" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vehicle_types"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "vehicles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vehicles"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "vehicle_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vehicle_documents"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============================================================================
-- Privilegios (ADR-034)
-- ============================================================================
-- yebo_app: sin DELETE. UPDATE por columna: la modalidad de un tipo, y el código y la modalidad de un vehículo, no
-- cambian (cambiar de tipo solo dentro de la misma modalidad: lo impide la FK compuesta); el tipo y el vehículo de un
-- documento tampoco.
GRANT SELECT ON "vehicle_type_catalog", "vehicle_document_types" TO yebo_app, yebo_backoffice;
GRANT SELECT, INSERT ON "vehicle_types" TO yebo_app;
GRANT UPDATE ("name", "catalog_code", "archived_at", "updated_at") ON "vehicle_types" TO yebo_app;
GRANT SELECT, INSERT ON "vehicles" TO yebo_app;
GRANT UPDATE ("name", "vehicle_type_id", "registration_id", "status", "ownership", "nominal_capacity", "features",
              "updated_at") ON "vehicles" TO yebo_app;
GRANT SELECT, INSERT ON "vehicle_documents" TO yebo_app;
GRANT UPDATE ("number", "issued_on", "expires_on", "file_asset_id", "archived_at", "updated_at") ON "vehicle_documents" TO yebo_app;
-- yebo_backoffice: el panel de YEBO las ve.
GRANT SELECT ON "vehicle_types", "vehicles", "vehicle_documents" TO yebo_backoffice;

-- ============================================================================
-- Catálogos (fuente: este archivo; la API los lee de la base)
-- ============================================================================
INSERT INTO "vehicle_type_catalog" ("code", "name", "modality", "sort_order") VALUES
  ('BUS', 'Bus', 'LAND', 1),
  ('MINIBUS', 'Minibús', 'LAND', 2),
  ('MINIVAN', 'Minivan', 'LAND', 3),
  ('CAR', 'Auto', 'LAND', 4),
  ('TRUCK', 'Camión', 'LAND', 5),
  ('LANCHA', 'Lancha', 'RIVER', 6),
  ('MOTONAVE', 'Motonave', 'RIVER', 7),
  ('DESLIZADOR', 'Deslizador', 'RIVER', 8),
  ('CHATA', 'Chata (barcaza)', 'RIVER', 9),
  ('BOTE', 'Bote', 'RIVER', 10)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "vehicle_document_types" ("code", "name", "modality", "sort_order") VALUES
  ('SOAT', 'SOAT', 'LAND', 1),
  ('REVISION_TECNICA', 'Revisión técnica', 'LAND', 2),
  ('TARJETA_PROPIEDAD', 'Tarjeta de propiedad', 'LAND', 3),
  ('CERT_MATRICULA', 'Certificado de matrícula', 'RIVER', 4),
  ('CERT_SEGURIDAD', 'Certificado de seguridad', 'RIVER', 5),
  ('POLIZA_SEGURO', 'Póliza de seguro', NULL, 6),
  ('OTRO', 'Otro documento', NULL, 7)
ON CONFLICT ("code") DO NOTHING;

-- ============================================================================
-- Permiso fleet.manage (fuente: permission-catalog.ts)
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'fleet.manage', 'FLEET', 'Gestionar los vehículos y sus documentos', false, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates" SET "permission_codes" = "permission_codes" || ARRAY['fleet.manage']::text[],
       "updated_at" = now()
 WHERE "code" = 'ADMIN' AND NOT ('fleet.manage' = ANY ("permission_codes"));

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
       WHERE p.code = 'fleet.manage'
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
