-- Fase 5.1 · Sitio público de la empresa (white label; data-dictionary §11; decisiones F5-Q1 a F5-Q6 del
-- responsable, 2026-11-10).
--   site_versions: documento de configuración versionado (config jsonb validado con Zod en la API). Como mucho un
--   borrador y una publicada por empresa (live_slot único). DRAFT editable; PUBLISHED y ARCHIVED inmutables salvo
--   PUBLISHED → ARCHIVED al publicar otra; nunca se borra. De tenant, con RLS forzado.
--   Permiso site.manage (plantilla Administrador): leer, guardar el borrador, publicar y restaurar.
--
-- Reversión (como yebo_owner; se pierden todas las versiones de los sitios):
--   DROP TABLE "site_versions";
--   DROP FUNCTION "site_versions_guard"();
--   DROP TYPE "site_version_status";
--   -- Permiso site.manage: quitarlo de role_permissions (tenant a tenant), de la plantilla ADMIN y de permissions.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261112010000_fase5_1_site_versions';

-- CreateEnum
CREATE TYPE "site_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "site_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "site_version_status" NOT NULL,
    "live_slot" "site_version_status",
    "schema_version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by_kind" "membership_change_actor",
    "published_by_id" UUID,

    CONSTRAINT "site_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_versions_tenant_id_id_key" ON "site_versions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "site_versions_tenant_id_version_key" ON "site_versions"("tenant_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "site_versions_tenant_id_live_slot_key" ON "site_versions"("tenant_id", "live_slot");

-- AddForeignKey
ALTER TABLE "site_versions" ADD CONSTRAINT "site_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ============================================================================
-- Reglas
-- ============================================================================
ALTER TABLE "site_versions"
  -- live_slot = estado si DRAFT o PUBLISHED; NULL si ARCHIVED: con el UNIQUE, uno de cada como mucho por empresa.
  ADD CONSTRAINT "site_versions_live_slot" CHECK ("live_slot" IS NOT DISTINCT FROM
    (CASE WHEN "status" = 'ARCHIVED' THEN NULL ELSE "status" END)),
  -- Publicada o archivada ⇔ con fecha y autor (miembro de la empresa o staff con soporte FULL).
  ADD CONSTRAINT "site_versions_published" CHECK (("status" = 'DRAFT') = ("published_at" IS NULL)
    AND ("published_at" IS NULL) = ("published_by_kind" IS NULL)
    AND ("published_by_kind" IS NULL) = ("published_by_id" IS NULL)
    AND ("published_by_kind" IS NULL OR "published_by_kind" IN ('MEMBERSHIP', 'PLATFORM_USER'))),
  ADD CONSTRAINT "site_versions_values" CHECK ("version" > 0 AND "schema_version" >= 1
    AND jsonb_typeof("config") = 'object' AND pg_column_size("config") <= 65536);

-- Borrador editable; publicada → solo archivarla; archivada, nada. Sin borrados. Se inserta como DRAFT o PUBLISHED
-- (restaurar publica una copia de una versión anterior en una fila nueva).
CREATE FUNCTION "site_versions_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'site_versions: las versiones no se borran' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'ARCHIVED' THEN
      RAISE EXCEPTION 'site_versions: una versión nace como borrador o publicada' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.version, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.version, OLD.created_at) THEN
    RAISE EXCEPTION 'site_versions: la identidad de una versión no cambia' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'DRAFT' THEN
    IF NEW.status = 'ARCHIVED' THEN
      RAISE EXCEPTION 'site_versions: un borrador se publica, no se archiva' USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.status = 'PUBLISHED' THEN
    IF NEW.status <> 'ARCHIVED' OR (NEW.config, NEW.schema_version, NEW.published_at, NEW.published_by_kind, NEW.published_by_id)
       IS DISTINCT FROM (OLD.config, OLD.schema_version, OLD.published_at, OLD.published_by_kind, OLD.published_by_id) THEN
      RAISE EXCEPTION 'site_versions: una versión publicada no cambia (solo se archiva)' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'site_versions: una versión archivada no cambia' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "site_versions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "site_versions"
  FOR EACH ROW EXECUTE FUNCTION "site_versions_guard"();

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025)
-- ============================================================================
ALTER TABLE "site_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "site_versions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============================================================================
-- Privilegios (ADR-034)
-- ============================================================================
-- yebo_app: la empresa edita su borrador, publica y restaura; el portal público lee la versión publicada.
GRANT SELECT, INSERT ON "site_versions" TO yebo_app;
GRANT UPDATE ("status", "live_slot", "config", "schema_version", "updated_at", "published_at", "published_by_kind",
              "published_by_id") ON "site_versions" TO yebo_app;
-- yebo_backoffice: el panel de YEBO ve el estado del sitio (no lo edita: F5-Q5).
GRANT SELECT ON "site_versions" TO yebo_backoffice;

-- ============================================================================
-- Permiso site.manage (fuente: permission-catalog.ts)
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'site.manage', 'SITE', 'Editar y publicar el sitio público de la empresa', true, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates" SET "permission_codes" = "permission_codes" || ARRAY['site.manage']::text[],
       "updated_at" = now()
 WHERE "code" = 'ADMIN' AND NOT ('site.manage' = ANY ("permission_codes"));

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
       WHERE p.code = 'site.manage'
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
