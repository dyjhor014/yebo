-- Fase 6.5 · Agencias externas (data-dictionary §3; decisión F6-Q2 del responsable, 2026-11-10; D7 sin validar).
--   agencies: de tenant, con RLS forzado. Solo el registro mínimo: nombre, RUC, contacto y estado (archived_at).
--   Nada se borra: se archiva, porque las ventas referenciarán a la agencia por su canal. El RUC no cambia después
--   del alta (privilegio por columna): forma el código de su canal y es único por empresa.
--   sales_channels.agency_id: cada agencia nace con su canal EXTERNAL_AGENCY (código AGENCIA-<RUC>) en la misma
--   transacción. Canal de agencia ⇔ con agencia (CHECK), y uno por agencia (UNIQUE). La agencia del canal no cambia.
--   Permiso agencies.manage (módulo AGENCIES, plantilla Administrador). Las rutas exigen además el módulo AGENCIES,
--   apagado por defecto: sin él, 403 MODULE_NOT_ENABLED. Sin comisiones ni usuarios de agencia (fases 8 y 11).
--
-- Reversión (como yebo_owner; se pierden las agencias y sus canales):
--   DELETE FROM "sales_channels" WHERE "kind" = 'EXTERNAL_AGENCY';   -- tenant a tenant (RLS forzado)
--   ALTER TABLE "sales_channels" DROP CONSTRAINT "sales_channels_agency", DROP COLUMN "agency_id";
--   DROP TABLE "agencies";
--   -- Permiso agencies.manage: quitarlo de role_permissions (tenant a tenant), de la plantilla ADMIN y de permissions.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261117010000_fase6_5_agencies';

-- AlterTable
ALTER TABLE "sales_channels" ADD COLUMN     "agency_id" UUID;

-- CreateTable
CREATE TABLE "agencies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agencies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agencies_tenant_id_id_key" ON "agencies"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "agencies_tenant_id_tax_id_key" ON "agencies"("tenant_id", "tax_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_channels_tenant_id_agency_id_key" ON "sales_channels"("tenant_id", "agency_id");

-- AddForeignKey
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_tenant_id_agency_id_fkey" FOREIGN KEY ("tenant_id", "agency_id") REFERENCES "agencies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agencies" ADD CONSTRAINT "agencies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ============================================================================
-- Reglas
-- ============================================================================
ALTER TABLE "agencies"
  ADD CONSTRAINT "agencies_name" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 2 AND 80),
  -- RUC peruano: 11 dígitos con prefijo de contribuyente. El dígito verificador lo comprueba la API.
  ADD CONSTRAINT "agencies_tax_id" CHECK ("tax_id" ~ '^(10|15|17|20)[0-9]{9}$'),
  ADD CONSTRAINT "agencies_contact" CHECK (
    ("contact_name" IS NULL OR char_length("contact_name") BETWEEN 2 AND 80)
    AND ("contact_phone" IS NULL OR char_length("contact_phone") BETWEEN 6 AND 20)
    AND ("contact_email" IS NULL OR (char_length("contact_email") <= 254 AND "contact_email" LIKE '%_@_%')));

-- Canal de agencia ⇔ con agencia (como el mostrador ⇔ con sucursal).
ALTER TABLE "sales_channels"
  ADD CONSTRAINT "sales_channels_agency" CHECK (("kind" = 'EXTERNAL_AGENCY') = ("agency_id" IS NOT NULL));

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025)
-- ============================================================================
ALTER TABLE "agencies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agencies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agencies"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============================================================================
-- Privilegios (ADR-034)
-- ============================================================================
-- yebo_app: sin DELETE (se archiva); el RUC no cambia. La columna agency_id de sales_channels solo se escribe al
-- crear el canal (INSERT ya concedido en la 6.1); su UPDATE no se concede.
GRANT SELECT, INSERT ON "agencies" TO yebo_app;
GRANT UPDATE ("name", "contact_name", "contact_phone", "contact_email", "archived_at", "updated_at")
  ON "agencies" TO yebo_app;
-- yebo_backoffice: el panel de YEBO las ve.
GRANT SELECT ON "agencies" TO yebo_backoffice;

-- ============================================================================
-- Permiso agencies.manage (fuente: permission-catalog.ts)
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'agencies.manage', 'AGENCIES', 'Gestionar las agencias externas y sus canales de venta', false, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates" SET "permission_codes" = "permission_codes" || ARRAY['agencies.manage']::text[],
       "updated_at" = now()
 WHERE "code" = 'ADMIN' AND NOT ('agencies.manage' = ANY ("permission_codes"));

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
       WHERE p.code = 'agencies.manage'
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
