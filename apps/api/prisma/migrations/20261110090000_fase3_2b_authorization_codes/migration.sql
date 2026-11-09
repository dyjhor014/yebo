-- Fase 3.2b · Códigos de autorización del hub de cuentas (OAuth 2.0 Authorization Code + PKCE S256; ADR-022,
-- identity-and-sessions §3–5). Tabla global con tenant_id (excepción declarada), solo para yebo_identity.
-- Sigue el modelo de privilegios vigente (ADR-034 aún no implementado): se retiran explícitamente los
-- privilegios por defecto de yebo_app y yebo_platform y se conceden los mínimos a yebo_identity.
-- Reversión: docs/development/phase-3-plan.md ("Etapa 3.2b · migración y reversión").

-- AlterEnum
ALTER TYPE "session_revoke_reason" ADD VALUE 'AUTH_CODE_REUSE';

-- CreateTable
CREATE TABLE "authorization_codes" (
    "id" UUID NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "identity_session_id" UUID NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "redemption_host" CITEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "code_challenge_method" TEXT NOT NULL DEFAULT 'S256',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "tenant_session_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "authorization_codes_code_hash_key" ON "authorization_codes"("code_hash");

-- CreateIndex
CREATE INDEX "authorization_codes_identity_session_id_idx" ON "authorization_codes"("identity_session_id");

-- CreateIndex
CREATE INDEX "authorization_codes_tenant_session_id_idx" ON "authorization_codes"("tenant_session_id");

-- AddForeignKey
ALTER TABLE "authorization_codes" ADD CONSTRAINT "authorization_codes_identity_session_id_user_id_fkey" FOREIGN KEY ("identity_session_id", "user_id") REFERENCES "identity_sessions"("id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "authorization_codes" ADD CONSTRAINT "authorization_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "authorization_codes" ADD CONSTRAINT "authorization_codes_tenant_session_id_fkey" FOREIGN KEY ("tenant_session_id") REFERENCES "tenant_sessions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ============================================================================
-- Restricciones que Prisma no modela (ADR-024)
-- ============================================================================
ALTER TABLE "authorization_codes"
  -- SHA-256 del código (el código en claro, ≥ 128 bits, nunca se guarda).
  ADD CONSTRAINT "authorization_codes_hash_length" CHECK (octet_length(code_hash) = 32),
  -- Solo PKCE S256; el reto es BASE64URL(SHA-256(code_verifier)) sin relleno: 43 caracteres.
  ADD CONSTRAINT "authorization_codes_pkce_s256" CHECK (code_challenge_method = 'S256' AND code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  -- El redirect_uri NO lo elige el cliente: se deriva del host verificado que canjea el código.
  ADD CONSTRAINT "authorization_codes_redirect_uri_derived" CHECK (redirect_uri = 'https://' || redemption_host::text || '/auth/callback'),
  ADD CONSTRAINT "authorization_codes_host_normalized" CHECK (redemption_host::text = lower(redemption_host::text) AND redemption_host::text !~ '[:/[:space:]]'),
  -- Vida máxima de 60 s.
  ADD CONSTRAINT "authorization_codes_lifetime" CHECK (expires_at > created_at - interval '5 seconds' AND expires_at <= created_at + interval '65 seconds'),
  -- Solo un código consumido puede tener sesión emitida.
  ADD CONSTRAINT "authorization_codes_session_after_consumption" CHECK (tenant_session_id IS NULL OR consumed_at IS NOT NULL);

-- ============================================================================
-- Privilegios: solo yebo_identity (sin DELETE). yebo_app y yebo_platform, ningún acceso.
-- ============================================================================
REVOKE ALL ON "authorization_codes" FROM yebo_app, yebo_platform;
GRANT SELECT, INSERT, UPDATE ON "authorization_codes" TO yebo_identity;
