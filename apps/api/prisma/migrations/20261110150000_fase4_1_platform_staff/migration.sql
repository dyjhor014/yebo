-- Fase 4.1 · Staff de YEBO: usuarios de plataforma, sesiones, enlaces de configuración y auditoría.
-- Realm separado de la identidad de clientes (multitenancy §1). Tablas globales exclusivas de yebo_backoffice
-- (decisión F4-Q2, ADR-034: lista blanca explícita, sin BYPASSRLS). Ningún otro rol de ejecución tiene acceso.
--
-- Reversión (como yebo_owner; solo si no hay datos que conservar):
--   DROP TABLE "platform_audit_logs", "platform_setup_tokens", "platform_sessions", "platform_users";
--   DROP TYPE "platform_session_revoke_reason", "platform_user_status", "platform_role";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261110150000_fase4_1_platform_staff';
-- CreateEnum
CREATE TYPE "platform_role" AS ENUM ('SUPERADMIN', 'BILLING', 'SUPPORT', 'VIEWER');

-- CreateEnum
CREATE TYPE "platform_user_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "platform_session_revoke_reason" AS ENUM ('LOGOUT', 'USER_DISABLED', 'ADMIN_REVOKED');

-- CreateTable
CREATE TABLE "platform_users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "password_hash" TEXT,
    "role" "platform_role" NOT NULL,
    "status" "platform_user_status" NOT NULL DEFAULT 'ACTIVE',
    "mfa_secret_ciphertext" BYTEA,
    "mfa_key_version" INTEGER,
    "mfa_enabled_at" TIMESTAMPTZ(6),
    "mfa_last_step" BIGINT,
    "password_changed_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_sessions" (
    "id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "ip" INET,
    "user_agent" TEXT,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" "platform_session_revoke_reason",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_setup_tokens" (
    "id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "issued_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_setup_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL,
    "platform_user_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "tenant_id" UUID,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "ip" INET,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_sessions_token_hash_key" ON "platform_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "platform_sessions_platform_user_id_idx" ON "platform_sessions"("platform_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_setup_tokens_token_hash_key" ON "platform_setup_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "platform_setup_tokens_platform_user_id_idx" ON "platform_setup_tokens"("platform_user_id");

-- CreateIndex
CREATE INDEX "platform_audit_logs_platform_user_id_occurred_at_idx" ON "platform_audit_logs"("platform_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "platform_audit_logs_tenant_id_occurred_at_idx" ON "platform_audit_logs"("tenant_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "platform_users" ADD CONSTRAINT "platform_users_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_setup_tokens" ADD CONSTRAINT "platform_setup_tokens_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_setup_tokens" ADD CONSTRAINT "platform_setup_tokens_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ============================================================================
-- Invariantes (CHECK)
-- ============================================================================
ALTER TABLE "platform_users"
  ADD CONSTRAINT "platform_users_email_normalized" CHECK ("email"::text = lower(btrim("email"::text)) AND "email"::text LIKE '%_@_%'),
  ADD CONSTRAINT "platform_users_full_name_present" CHECK (length(btrim("full_name")) BETWEEN 1 AND 200),
  -- MFA activa ⇒ secreto cifrado y versión de clave presentes.
  ADD CONSTRAINT "platform_users_mfa_consistent" CHECK (
    ("mfa_secret_ciphertext" IS NULL) = ("mfa_key_version" IS NULL)
    AND ("mfa_enabled_at" IS NULL OR "mfa_secret_ciphertext" IS NOT NULL)
  );

ALTER TABLE "platform_sessions"
  ADD CONSTRAINT "platform_sessions_token_hash_length" CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "platform_sessions_expiry_order" CHECK ("idle_expires_at" <= "absolute_expires_at"),
  ADD CONSTRAINT "platform_sessions_revoke_consistent" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL));

ALTER TABLE "platform_setup_tokens"
  ADD CONSTRAINT "platform_setup_tokens_hash_length" CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "platform_setup_tokens_lifetime" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '72 hours');

ALTER TABLE "platform_audit_logs"
  ADD CONSTRAINT "platform_audit_logs_action_format" CHECK ("action" ~ '^[a-z][a-z0-9_.]{2,99}$');

-- ============================================================================
-- Privilegios (ADR-034: lista blanca). La auditoría es append-only para el rol de ejecución.
-- ============================================================================
GRANT SELECT, INSERT, UPDATE ON "platform_users", "platform_sessions", "platform_setup_tokens" TO yebo_backoffice;
GRANT SELECT, INSERT ON "platform_audit_logs" TO yebo_backoffice;
