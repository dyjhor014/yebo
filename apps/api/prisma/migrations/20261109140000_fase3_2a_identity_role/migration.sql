-- Fase 3.2a · Correcciones de la auditoría (2026-11-09).
--   1. Rol dedicado yebo_identity con privilegios mínimos y explícitos; yebo_platform deja de acceder a las
--      tablas de sesión (multitenancy §4; patrón de ADR-028).
--   2. Sucesor del refresh token cifrado con AES-256-GCM (clave HKDF del token padre) en lugar de en claro en Redis.
-- REQUISITO: el rol yebo_identity debe existir antes de migrar (los roles son del clúster, no de la base):
--   volúmenes nuevos → infrastructure/docker/postgres/init/01-roles-and-databases.sh;
--   volúmenes existentes → scripts/dev/create-identity-role.sh.
-- Reversión documentada en docs/development/phase-3-plan.md ("Migración 20261109140000 y su reversión").

-- AddColumn
ALTER TABLE "refresh_tokens" ADD COLUMN "successor_ciphertext" BYTEA;

-- 1 byte de versión + 12 de IV + 32 del sucesor + 16 de etiqueta GCM. Solo existe en un token ya rotado.
ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_successor_ciphertext_shape"
  CHECK (successor_ciphertext IS NULL OR (rotated_at IS NOT NULL AND octet_length(successor_ciphertext) = 61));

-- ============================================================================
-- Privilegios
-- ============================================================================
-- Las tablas de sesión dejan de estar al alcance de yebo_platform (BYPASSRLS, DML sobre todo): solo identity.
REVOKE ALL ON "identity_sessions", "tenant_sessions", "refresh_tokens" FROM yebo_platform;

-- yebo_identity: sin DELETE ni TRUNCATE (las sesiones se revocan, no se borran; la purga será un proceso aparte).
GRANT SELECT, INSERT, UPDATE ON "identity_sessions", "tenant_sessions", "refresh_tokens" TO yebo_identity;
-- Solo lectura de lo necesario para autenticar y abrir sesiones.
GRANT SELECT ON "users", "tenant_memberships", "tenant_domains" TO yebo_identity;

-- tenant_memberships tiene RLS FORZADO por tenant (ADR-003/025). Identidad es global: necesita leer las
-- membresías de un usuario en todas sus empresas. Política explícita SOLO de lectura y SOLO para este rol,
-- en lugar de BYPASSRLS (que afectaría a cualquier tabla a la que se le diera acceso en el futuro).
CREATE POLICY "identity_read_memberships" ON "tenant_memberships"
  AS PERMISSIVE FOR SELECT TO yebo_identity USING (true);
