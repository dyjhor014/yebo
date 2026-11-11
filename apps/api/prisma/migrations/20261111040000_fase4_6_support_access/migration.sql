-- Fase 4.6 · Acceso de soporte del staff de YEBO a una empresa (multitenancy §1; security.md §2; decisiones del
-- responsable del 2026-11-10: hasta 8 h, sin aprobación por defecto, registro de cada petición, READ_ONLY = solo READ).
--   support_access_grants: temporal, con motivo, personal (un miembro del staff), visible para la empresa, con
--     aprobación opcional (tenant_settings.support_requires_approval) y revocable por el staff o la empresa.
--   support_handoffs: código de un solo uso (60 s) que el navegador canjea en el host de la empresa.
--   support_sessions: sesión de soporte en la empresa (cookie opaca; solo su SHA-256), 30 min de inactividad.
--   support_access_logs: cada petición del staff en la empresa (append-only).
-- Todas de tenant con RLS forzado.
--
-- Reversión (como yebo_owner; se pierde el registro de accesos):
--   DROP TABLE "support_access_logs", "support_sessions", "support_handoffs", "support_access_grants";
--   DROP FUNCTION "support_access_logs_append_only"();
--   DROP TYPE "support_scope";
--   ALTER TABLE "tenant_settings" DROP COLUMN "support_requires_approval";
--   -- Permisos support.read y support.manage: quitarlos de role_permissions (tenant a tenant), de la plantilla ADMIN
--   -- y de permissions.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261111040000_fase4_6_support_access';

-- CreateEnum
CREATE TYPE "support_scope" AS ENUM ('READ_ONLY', 'FULL');

-- AlterTable
ALTER TABLE "tenant_settings" ADD COLUMN "support_requires_approval" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "support_access_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    -- Copia del nombre y el correo del staff al crear el acceso: la empresa ve quién, sin leer platform_users.
    "staff_name" TEXT NOT NULL,
    "staff_email" CITEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "scope" "support_scope" NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "requires_approval" BOOLEAN NOT NULL,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_membership_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_kind" "membership_change_actor",
    "revoked_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_access_grants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support_handoffs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_handoffs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support_access_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_access_grants_tenant_id_id_key" ON "support_access_grants"("tenant_id", "id");
CREATE INDEX "support_access_grants_tenant_id_expires_at_idx" ON "support_access_grants"("tenant_id", "expires_at");
CREATE UNIQUE INDEX "support_handoffs_code_hash_key" ON "support_handoffs"("code_hash");
CREATE UNIQUE INDEX "support_handoffs_tenant_id_id_key" ON "support_handoffs"("tenant_id", "id");
CREATE UNIQUE INDEX "support_sessions_token_hash_key" ON "support_sessions"("token_hash");
CREATE UNIQUE INDEX "support_sessions_tenant_id_id_key" ON "support_sessions"("tenant_id", "id");
CREATE INDEX "support_sessions_grant_id_idx" ON "support_sessions"("grant_id");
CREATE UNIQUE INDEX "support_access_logs_tenant_id_id_key" ON "support_access_logs"("tenant_id", "id");
CREATE INDEX "support_access_logs_tenant_id_grant_id_occurred_at_idx" ON "support_access_logs"("tenant_id", "grant_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_tenant_id_approved_by_membership_id_fkey" FOREIGN KEY ("tenant_id", "approved_by_membership_id") REFERENCES "tenant_memberships"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_handoffs" ADD CONSTRAINT "support_handoffs_tenant_id_grant_id_fkey" FOREIGN KEY ("tenant_id", "grant_id") REFERENCES "support_access_grants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_tenant_id_grant_id_fkey" FOREIGN KEY ("tenant_id", "grant_id") REFERENCES "support_access_grants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_access_logs" ADD CONSTRAINT "support_access_logs_tenant_id_grant_id_fkey" FOREIGN KEY ("tenant_id", "grant_id") REFERENCES "support_access_grants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ============================================================================
-- Invariantes (CHECK)
-- ============================================================================
ALTER TABLE "support_access_grants"
  ADD CONSTRAINT "support_access_grants_window" CHECK ("expires_at" > "starts_at"
    AND "expires_at" <= "starts_at" + interval '8 hours'),
  ADD CONSTRAINT "support_access_grants_reason" CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  ADD CONSTRAINT "support_access_grants_approval" CHECK (("approved_at" IS NULL) = ("approved_by_membership_id" IS NULL)
    AND ("requires_approval" OR "approved_at" IS NULL)),
  ADD CONSTRAINT "support_access_grants_revoked" CHECK (("revoked_at" IS NULL) = ("revoked_by_kind" IS NULL)
    AND ("revoked_by_kind" IS NULL OR "revoked_by_kind" IN ('PLATFORM_USER', 'MEMBERSHIP'))
    AND (("revoked_by_kind" IS NULL) = ("revoked_by_id" IS NULL)));

ALTER TABLE "support_handoffs"
  ADD CONSTRAINT "support_handoffs_hash" CHECK (octet_length("code_hash") = 32),
  ADD CONSTRAINT "support_handoffs_ttl" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '2 minutes');

ALTER TABLE "support_sessions"
  ADD CONSTRAINT "support_sessions_hash" CHECK (octet_length("token_hash") = 32);

ALTER TABLE "support_access_logs"
  ADD CONSTRAINT "support_access_logs_values" CHECK ("method" ~ '^[A-Z]{3,7}$' AND length("route") BETWEEN 1 AND 300);

-- El registro de accesos es append-only también para el propietario (salvo TRUNCATE de mantenimiento).
CREATE FUNCTION "support_access_logs_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'support_access_logs es append-only' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER "support_access_logs_append_only" BEFORE UPDATE OR DELETE ON "support_access_logs"
  FOR EACH ROW EXECUTE FUNCTION "support_access_logs_append_only"();

-- ============================================================================
-- RLS forzado
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['support_access_grants','support_handoffs','support_sessions','support_access_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ============================================================================
-- Permisos support.read y support.manage (fuente: permission-catalog.ts)
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'support.read', 'ACCESS', 'Ver los accesos de soporte de YEBO y su registro', false, now()),
  (gen_random_uuid(), 'support.manage', 'ACCESS', 'Aprobar o revocar accesos de soporte de YEBO', true, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates" SET "permission_codes" = "permission_codes" || ARRAY['support.read', 'support.manage']::text[],
       "updated_at" = now()
 WHERE "code" = 'ADMIN' AND NOT ('support.read' = ANY ("permission_codes"));

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
       WHERE p.code IN ('support.read', 'support.manage')
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- ============================================================================
-- Privilegios (ADR-034)
-- ============================================================================
-- yebo_backoffice: el staff crea y revoca accesos, emite códigos, canjea y verifica sesiones y registra peticiones.
GRANT SELECT, INSERT ON "support_access_grants", "support_handoffs", "support_sessions", "support_access_logs" TO yebo_backoffice;
GRANT UPDATE ("revoked_at", "revoked_by_kind", "revoked_by_id") ON "support_access_grants" TO yebo_backoffice;
GRANT UPDATE ("consumed_at") ON "support_handoffs" TO yebo_backoffice;
GRANT UPDATE ("last_seen_at", "idle_expires_at", "revoked_at") ON "support_sessions" TO yebo_backoffice;
-- yebo_app (empresa): ve los accesos y su registro, los aprueba o revoca y decide si exige aprobación.
GRANT SELECT ON "support_access_grants", "support_access_logs" TO yebo_app;
GRANT UPDATE ("approved_at", "approved_by_membership_id", "revoked_at", "revoked_by_kind", "revoked_by_id")
  ON "support_access_grants" TO yebo_app;
GRANT UPDATE ("support_requires_approval", "updated_at") ON "tenant_settings" TO yebo_app;
