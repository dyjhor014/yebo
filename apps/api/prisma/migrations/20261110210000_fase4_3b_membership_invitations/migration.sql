-- Fase 4.3b · Invitaciones de membresía (multitenancy §1.1; data-dictionary §2; F4-Q3; decisiones del 2026-11-10).
--   membership_invitations (de tenant, RLS forzado): enlace de un solo uso con el SHA-256 del secreto, caducidad,
--   roles, quién invita (una membresía de la empresa o el staff de YEBO), aceptación o revocación.
--   El token del enlace lleva el id del tenant ("<tenant>.<secreto>"): el hub fija el contexto del tenant ANTES de
--   buscar el hash, así que la tabla conserva el RLS sin excepciones globales.
--   Permiso nuevo `members.invite` (USERS_ADD), añadido a la plantilla Administrador y a los roles ya creados desde
--   ella (con versión de permisos incrementada para que los tokens vigentes se renueven).
--
-- Reversión (como yebo_owner; solo si no hay invitaciones que conservar):
--   DROP TABLE "membership_invitations";
--   -- Para cada tenant (con set_config('app.tenant_id', ...)): DELETE FROM role_permissions WHERE permission_id =
--   --   (SELECT id FROM permissions WHERE code = 'members.invite');
--   UPDATE "role_templates" SET permission_codes = array_remove(permission_codes, 'members.invite') WHERE code = 'ADMIN';
--   DELETE FROM "permissions" WHERE code = 'members.invite';
--   REVOKE INSERT ON "users" FROM yebo_identity;
--   REVOKE INSERT, UPDATE ON "tenant_memberships" FROM yebo_identity;
--   REVOKE SELECT, INSERT ON "membership_roles" FROM yebo_identity;
--   REVOKE SELECT ON "roles", "tenant_operation_overrides" FROM yebo_identity;
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261110210000_fase4_3b_membership_invitations';

-- CreateTable
CREATE TABLE "membership_invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role_ids" UUID[],
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "invited_by_membership_id" UUID,
    "invited_by_platform_user_id" UUID,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_membership_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "membership_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "membership_invitations_token_hash_key" ON "membership_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "membership_invitations_tenant_id_created_at_idx" ON "membership_invitations"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "membership_invitations_tenant_id_id_key" ON "membership_invitations"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_tenant_id_invited_by_membership_id_fkey" FOREIGN KEY ("tenant_id", "invited_by_membership_id") REFERENCES "tenant_memberships"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_tenant_id_accepted_membership_id_fkey" FOREIGN KEY ("tenant_id", "accepted_membership_id") REFERENCES "tenant_memberships"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_invited_by_platform_user_id_fkey" FOREIGN KEY ("invited_by_platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ============================================================================
-- Invariantes (CHECK)
-- ============================================================================
ALTER TABLE "membership_invitations"
  ADD CONSTRAINT "membership_invitations_email_normalized" CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1),
  ADD CONSTRAINT "membership_invitations_roles_present" CHECK (cardinality("role_ids") BETWEEN 1 AND 20),
  ADD CONSTRAINT "membership_invitations_token_hash_length" CHECK (octet_length("token_hash") = 32),
  -- Caducidad corta (F4-Q3): como mucho 7 días.
  ADD CONSTRAINT "membership_invitations_expiry" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '7 days'),
  -- Exactamente un origen: una membresía de la empresa o el staff de YEBO.
  ADD CONSTRAINT "membership_invitations_one_inviter" CHECK (num_nonnulls("invited_by_membership_id", "invited_by_platform_user_id") = 1),
  ADD CONSTRAINT "membership_invitations_accepted_consistent" CHECK (("accepted_at" IS NULL) = ("accepted_membership_id" IS NULL)),
  ADD CONSTRAINT "membership_invitations_final_once" CHECK ("accepted_at" IS NULL OR "revoked_at" IS NULL);

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025).
-- ============================================================================
ALTER TABLE "membership_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "membership_invitations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============================================================================
-- Permiso members.invite (fuente: src/modules/access/permission-catalog.ts)
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'members.invite', 'ACCESS', 'Invitar personas a la empresa', true, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates" SET "permission_codes" = array_append("permission_codes", 'members.invite'), "updated_at" = now()
 WHERE "code" = 'ADMIN' AND NOT ('members.invite' = ANY ("permission_codes"));

-- Roles ya creados desde la plantilla Administrador: el RLS forzado obliga a recorrerlos tenant a tenant.
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
      SELECT r.tenant_id, r.id, p.id
        FROM "roles" r JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
        CROSS JOIN "permissions" p
       WHERE p.code = 'members.invite'
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- ============================================================================
-- Privilegios (ADR-034: lista blanca)
-- ============================================================================
-- yebo_app (empresa): invitar, listar y revocar las invitaciones de su tenant.
GRANT SELECT, INSERT ON "membership_invitations" TO yebo_app;
GRANT UPDATE ("revoked_at") ON "membership_invitations" TO yebo_app;
-- yebo_backoffice (staff): invitar al primer administrador en el alta o reemitir su invitación.
GRANT SELECT, INSERT ON "membership_invitations" TO yebo_backoffice;
-- yebo_identity (hub): aceptar. Crea la cuenta si no existe (decisión del 2026-11-10), la membresía y sus roles,
-- siempre con el contexto del tenant de la invitación.
GRANT SELECT ON "membership_invitations" TO yebo_identity;
GRANT UPDATE ("accepted_at", "accepted_membership_id") ON "membership_invitations" TO yebo_identity;
GRANT INSERT ON "users" TO yebo_identity;
GRANT INSERT ON "tenant_memberships" TO yebo_identity;
GRANT UPDATE ("status", "permissions_version", "updated_at") ON "tenant_memberships" TO yebo_identity;
GRANT SELECT, INSERT ON "membership_roles" TO yebo_identity;
GRANT SELECT ON "roles", "tenant_operation_overrides" TO yebo_identity;
