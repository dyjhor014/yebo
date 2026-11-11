-- Fase 5.2 · Archivos de la empresa (data-dictionary §11 file_assets; F5-Q2 actualizado: MinIO archivado → Garage).
--   file_assets: metadatos de cada archivo guardado en el almacenamiento S3 (logo y portada del sitio, por ahora).
--   Los objetos son privados en el bucket; la API sirve solo los PUBLIC y READY de la empresa del host. Las imágenes
--   se recodifican al subirlas (sin EXIF). De tenant, con RLS forzado. Sin borrados: se marcan DELETED.
--
-- Reversión (como yebo_owner; los objetos del bucket quedan huérfanos y se pueden borrar con la herramienta S3):
--   DROP TABLE "file_assets";
--   DROP TYPE "file_asset_status", "file_asset_visibility", "file_asset_kind";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261112020000_fase5_2_file_assets';

-- CreateEnum
CREATE TYPE "file_asset_kind" AS ENUM ('SITE_LOGO', 'SITE_HERO');

-- CreateEnum
CREATE TYPE "file_asset_visibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "file_asset_status" AS ENUM ('PENDING', 'READY', 'REJECTED', 'DELETED');

-- CreateTable
CREATE TABLE "file_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "kind" "file_asset_kind" NOT NULL,
    "visibility" "file_asset_visibility" NOT NULL,
    "status" "file_asset_status" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "checksum_sha256" BYTEA NOT NULL,
    "original_name" TEXT,
    "uploaded_by_kind" "membership_change_actor" NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_assets_storage_key_key" ON "file_assets"("storage_key");

-- CreateIndex
CREATE INDEX "file_assets_tenant_id_kind_idx" ON "file_assets"("tenant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "file_assets_tenant_id_id_key" ON "file_assets"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ============================================================================
-- Reglas
-- ============================================================================
ALTER TABLE "file_assets"
  ADD CONSTRAINT "file_assets_values" CHECK ("size_bytes" > 0 AND "size_bytes" <= 5242880
    AND "width" BETWEEN 1 AND 8192 AND "height" BETWEEN 1 AND 8192
    AND octet_length("checksum_sha256") = 32
    AND "mime" IN ('image/png', 'image/jpeg', 'image/webp')
    AND ("original_name" IS NULL OR length("original_name") <= 255)),
  -- La clave del objeto empieza por la empresa: un objeto nunca se comparte entre empresas.
  ADD CONSTRAINT "file_assets_storage_key" CHECK ("storage_key" LIKE 'tenants/' || "tenant_id"::text || '/%'),
  ADD CONSTRAINT "file_assets_uploader" CHECK ("uploaded_by_kind" IN ('MEMBERSHIP', 'PLATFORM_USER'));

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025)
-- ============================================================================
ALTER TABLE "file_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "file_assets" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "file_assets"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============================================================================
-- Privilegios (ADR-034)
-- ============================================================================
-- yebo_app: la empresa sube y consulta sus archivos; solo cambia el estado (nunca borra la fila).
GRANT SELECT, INSERT ON "file_assets" TO yebo_app;
GRANT UPDATE ("status") ON "file_assets" TO yebo_app;
-- yebo_backoffice: el panel de YEBO ve los archivos del sitio (F5-Q5: no los edita).
GRANT SELECT ON "file_assets" TO yebo_backoffice;
