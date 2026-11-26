-- Fase 6.1 · Ubicaciones, sucursales y canales de venta (data-dictionary §2–3; decisiones F6-Q1 a F6-Q7 del
-- responsable, 2026-11-10).
--   location_kinds 🌐: catálogo global de tipos (ciudad, puerto, embarcadero, terminal).
--   locations, branches, sales_channels, membership_branch_scopes: de tenant, con RLS forzado. Lo que se retira se
--   archiva (archived_at): los viajes y las ventas lo referenciarán. El código de una sucursal y la clase y la
--   sucursal de un canal no cambian (privilegios por columna). Un mostrador por sucursal (UNIQUE tenant, sucursal,
--   clase) y un canal ONLINE por empresa (código fijo ONLINE, UNIQUE tenant, código).
--   Permiso locations.manage (plantilla Administrador). El ámbito de sucursal de una membresía (F6-Q4) se gestiona
--   con roles.assign.
--
-- Reversión (como yebo_owner; se pierden las ubicaciones, sucursales, canales y ámbitos):
--   DROP TABLE "membership_branch_scopes", "sales_channels", "branches", "locations", "location_kinds";
--   DROP TYPE "sales_channel_kind";
--   -- Permiso locations.manage: quitarlo de role_permissions (tenant a tenant), de la plantilla ADMIN y de permissions.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261113010000_fase6_1_locations_branches';

-- CreateEnum
CREATE TYPE "sales_channel_kind" AS ENUM ('COUNTER', 'ONLINE', 'EXTERNAL_AGENCY', 'CALL_CENTER', 'API');

-- CreateTable
CREATE TABLE "location_kinds" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "location_kinds_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind_code" TEXT NOT NULL,
    "ubigeo" CHAR(6),
    "region" TEXT,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "tax_zone_code" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "phones" JSONB NOT NULL DEFAULT '[]',
    "is_pickup_point" BOOLEAN NOT NULL DEFAULT false,
    "is_reception_point" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_channels" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "sales_channel_kind" NOT NULL,
    "branch_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_branch_scopes" (
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_branch_scopes_pkey" PRIMARY KEY ("tenant_id","membership_id","branch_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "locations_tenant_id_id_key" ON "locations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "locations_tenant_id_name_key" ON "locations"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "branches_tenant_id_location_id_idx" ON "branches"("tenant_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenant_id_id_key" ON "branches"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenant_id_code_key" ON "branches"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "sales_channels_tenant_id_id_key" ON "sales_channels"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_channels_tenant_id_code_key" ON "sales_channels"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "sales_channels_tenant_id_branch_id_kind_key" ON "sales_channels"("tenant_id", "branch_id", "kind");

-- CreateIndex
CREATE INDEX "membership_branch_scopes_tenant_id_branch_id_idx" ON "membership_branch_scopes"("tenant_id", "branch_id");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_kind_code_fkey" FOREIGN KEY ("kind_code") REFERENCES "location_kinds"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_branch_scopes" ADD CONSTRAINT "membership_branch_scopes_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "tenant_memberships"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_branch_scopes" ADD CONSTRAINT "membership_branch_scopes_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ============================================================================
-- Reglas
-- ============================================================================
ALTER TABLE "location_kinds"
  ADD CONSTRAINT "location_kinds_code" CHECK ("code" ~ '^[A-Z][A-Z_]{1,23}$');

ALTER TABLE "locations"
  ADD CONSTRAINT "locations_name" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 2 AND 80),
  ADD CONSTRAINT "locations_ubigeo" CHECK ("ubigeo" IS NULL OR "ubigeo" ~ '^[0-9]{6}$'),
  ADD CONSTRAINT "locations_region" CHECK ("region" IS NULL OR char_length("region") BETWEEN 2 AND 60),
  ADD CONSTRAINT "locations_coordinates" CHECK (("lat" IS NULL) = ("lng" IS NULL)
    AND ("lat" IS NULL OR "lat" BETWEEN -90 AND 90) AND ("lng" IS NULL OR "lng" BETWEEN -180 AND 180));

ALTER TABLE "branches"
  ADD CONSTRAINT "branches_code" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{0,11}$'),
  ADD CONSTRAINT "branches_text" CHECK (char_length("name") BETWEEN 2 AND 80 AND char_length("address") BETWEEN 3 AND 200),
  ADD CONSTRAINT "branches_phones" CHECK (jsonb_typeof("phones") = 'array' AND jsonb_array_length("phones") <= 4);

ALTER TABLE "sales_channels"
  ADD CONSTRAINT "sales_channels_text" CHECK (char_length("code") BETWEEN 2 AND 40 AND char_length("name") BETWEEN 2 AND 80),
  -- Mostrador ⇔ con sucursal; ONLINE ⇔ código ONLINE (uno por empresa por el UNIQUE de código).
  ADD CONSTRAINT "sales_channels_counter_branch" CHECK (("kind" = 'COUNTER') = ("branch_id" IS NOT NULL)),
  ADD CONSTRAINT "sales_channels_online_code" CHECK (("kind" = 'ONLINE') = ("code" = 'ONLINE'));

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025)
-- ============================================================================
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "locations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "branches"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales_channels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_channels" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_channels"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "membership_branch_scopes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_branch_scopes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "membership_branch_scopes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============================================================================
-- Privilegios (ADR-034)
-- ============================================================================
-- yebo_app: la empresa gestiona lo suyo. Sin DELETE (se archiva), salvo el ámbito de sucursal, que es una relación.
-- UPDATE por columna: el código de una sucursal, y la clase, el código y la sucursal de un canal, no cambian.
GRANT SELECT ON "location_kinds" TO yebo_app, yebo_backoffice;
GRANT SELECT, INSERT ON "locations" TO yebo_app;
GRANT UPDATE ("name", "kind_code", "ubigeo", "region", "lat", "lng", "archived_at", "updated_at") ON "locations" TO yebo_app;
GRANT SELECT, INSERT ON "branches" TO yebo_app;
GRANT UPDATE ("location_id", "name", "address", "phones", "is_pickup_point", "is_reception_point", "archived_at",
              "updated_at") ON "branches" TO yebo_app;
GRANT SELECT, INSERT ON "sales_channels" TO yebo_app;
GRANT UPDATE ("name", "is_active", "updated_at") ON "sales_channels" TO yebo_app;
GRANT SELECT, INSERT, DELETE ON "membership_branch_scopes" TO yebo_app;
-- yebo_backoffice: el panel de YEBO las ve; el alta de una empresa crea su canal ONLINE.
GRANT SELECT ON "locations", "branches", "membership_branch_scopes" TO yebo_backoffice;
GRANT SELECT, INSERT ON "sales_channels" TO yebo_backoffice;

-- ============================================================================
-- Catálogo de tipos de ubicación (fuente: LOCATION_KINDS en @yebo/contracts)
-- ============================================================================
INSERT INTO "location_kinds" ("code", "name", "sort_order") VALUES
  ('CITY', 'Ciudad', 1),
  ('PORT', 'Puerto', 2),
  ('LANDING', 'Embarcadero', 3),
  ('TERMINAL', 'Terminal terrestre', 4)
ON CONFLICT ("code") DO NOTHING;

-- ============================================================================
-- Permiso locations.manage (fuente: permission-catalog.ts) y canal ONLINE de las empresas existentes
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'locations.manage', 'LOCATIONS', 'Gestionar ubicaciones, sucursales y canales de venta', false, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates" SET "permission_codes" = "permission_codes" || ARRAY['locations.manage']::text[],
       "updated_at" = now()
 WHERE "code" = 'ADMIN' AND NOT ('locations.manage' = ANY ("permission_codes"));

-- Tenant a tenant por el RLS forzado: el permiso en los roles Administrador y el canal ONLINE.
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
      SELECT r.tenant_id, r.id, p.id
        FROM "roles" r JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
        CROSS JOIN "permissions" p
       WHERE p.code = 'locations.manage'
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
    INSERT INTO "sales_channels" ("id", "tenant_id", "code", "name", "kind")
      VALUES (gen_random_uuid(), t, 'ONLINE', 'Venta en línea', 'ONLINE')
      ON CONFLICT ("tenant_id", "code") DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
