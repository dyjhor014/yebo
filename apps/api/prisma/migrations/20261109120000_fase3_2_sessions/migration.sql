-- Fase 3.2 · Sesiones de identidad y de empresa, refresh tokens (ADR-009, ADR-022; identity-and-sessions §6–8, §11).
-- Tablas globales gestionadas por identidad con yebo_platform. yebo_app no tiene NINGÚN acceso.

-- CreateEnum
CREATE TYPE "session_revoke_reason" AS ENUM ('LOGOUT', 'LOGOUT_ALL', 'PASSWORD_CHANGED', 'MEMBERSHIP_REVOKED', 'ADMIN_REVOKED', 'REFRESH_REUSE', 'USER_DISABLED');

-- CreateTable
CREATE TABLE "identity_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ip" INET,
    "user_agent" TEXT,
    "auth_methods" TEXT[],
    "mfa_verified_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" "session_revoke_reason",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_sessions" (
    "id" UUID NOT NULL,
    "identity_session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "host" CITEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" "session_revoke_reason",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "tenant_session_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "parent_id" UUID,
    "rotated_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identity_sessions_user_id_idx" ON "identity_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_sessions_id_user_id_key" ON "identity_sessions"("id", "user_id");

-- CreateIndex
CREATE INDEX "tenant_sessions_identity_session_id_idx" ON "tenant_sessions"("identity_session_id");

-- CreateIndex
CREATE INDEX "tenant_sessions_user_id_idx" ON "tenant_sessions"("user_id");

-- CreateIndex
CREATE INDEX "tenant_sessions_tenant_id_membership_id_idx" ON "tenant_sessions"("tenant_id", "membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tenant_session_id_id_key" ON "refresh_tokens"("tenant_session_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tenant_session_id_parent_id_key" ON "refresh_tokens"("tenant_session_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_memberships_tenant_id_user_id_id_key" ON "tenant_memberships"("tenant_id", "user_id", "id");

-- AddForeignKey
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_sessions" ADD CONSTRAINT "tenant_sessions_identity_session_id_user_id_fkey" FOREIGN KEY ("identity_session_id", "user_id") REFERENCES "identity_sessions"("id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_sessions" ADD CONSTRAINT "tenant_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_sessions" ADD CONSTRAINT "tenant_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_sessions" ADD CONSTRAINT "tenant_sessions_tenant_id_user_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "user_id", "membership_id") REFERENCES "tenant_memberships"("tenant_id", "user_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_session_id_fkey" FOREIGN KEY ("tenant_session_id") REFERENCES "tenant_sessions"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_session_id_parent_id_fkey" FOREIGN KEY ("tenant_session_id", "parent_id") REFERENCES "refresh_tokens"("tenant_session_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ============================================================================
-- Restricciones que Prisma no modela (ADR-024)
-- ============================================================================
ALTER TABLE "identity_sessions"
  ADD CONSTRAINT "identity_sessions_auth_methods_not_null" CHECK (auth_methods IS NOT NULL),
  ADD CONSTRAINT "identity_sessions_expiry_order" CHECK (idle_expires_at <= absolute_expires_at),
  ADD CONSTRAINT "identity_sessions_revocation_consistent" CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL));

ALTER TABLE "tenant_sessions"
  ADD CONSTRAINT "tenant_sessions_expiry_order" CHECK (idle_expires_at <= absolute_expires_at),
  ADD CONSTRAINT "tenant_sessions_revocation_consistent" CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  ADD CONSTRAINT "tenant_sessions_host_normalized" CHECK (host::text = lower(host::text) AND host::text !~ '[:/[:space:]]');

ALTER TABLE "refresh_tokens"
  -- SHA-256: 32 bytes. Nunca se guarda el token en claro.
  ADD CONSTRAINT "refresh_tokens_hash_length" CHECK (octet_length(token_hash) = 32),
  ADD CONSTRAINT "refresh_tokens_not_own_parent" CHECK (parent_id IS NULL OR parent_id <> id);

-- ============================================================================
-- Privilegios (multitenancy §4.3): sesiones y tokens solo con yebo_platform.
-- ============================================================================
REVOKE ALL ON "identity_sessions", "tenant_sessions", "refresh_tokens" FROM yebo_app;
