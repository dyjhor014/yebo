-- ADR-034 · Parte B: separación efectiva de privilegios (aceptado el 2026-11-09; aplicado el 2026-11-10).
-- La parte A (atributos de rol: yebo_platform sin BYPASSRLS, sin herencia ni pertenencias) es de clúster: init de
-- PostgreSQL para volúmenes nuevos y scripts/dev/harden-roles.sh para los existentes.
--
-- B1. Privilegios por defecto: de lista negra a LISTA BLANCA. Ninguna tabla, secuencia o función futura concede
--     nada a los roles de ejecución: cada migración declara sus GRANT (y una prueba compara la foto de privilegios).
-- B2. Estado actual: se parte de cero para los tres roles de ejecución y se concede la lista blanca. Incluye
--     _prisma_migrations, que queda SOLO para yebo_owner.
-- B3. RLS sin cambios: tenant_isolation (forzado) en las 4 tablas de tenant e identity_read_memberships.
--
-- Reversión: docs/development/phase-3-plan.md, "ADR-034 · reversión".

-- B1 ------------------------------------------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner IN SCHEMA public REVOKE ALL ON TABLES    FROM yebo_app, yebo_platform, yebo_identity;
ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM yebo_app, yebo_platform, yebo_identity;
ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM yebo_app, yebo_platform, yebo_identity;
-- Funciones propias futuras: tampoco para PUBLIC (las de las extensiones, de postgres, no se tocan).
ALTER DEFAULT PRIVILEGES FOR ROLE yebo_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- B2 ------------------------------------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM yebo_app, yebo_platform, yebo_identity;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM yebo_app, yebo_platform, yebo_identity;

-- yebo_app (API y worker con RLS): configuración de roles del tenant, catálogos y membresías.
GRANT SELECT, INSERT, UPDATE, DELETE ON "roles", "role_permissions", "membership_roles" TO yebo_app;
GRANT SELECT ON "permissions", "role_templates", "tenant_memberships" TO yebo_app;
GRANT UPDATE ("status", "permissions_version", "updated_at") ON "tenant_memberships" TO yebo_app;   -- Fase 3.3

-- yebo_identity (solo el módulo identity): sesiones, tokens y códigos; lectura de identidad y dominios.
GRANT SELECT, INSERT, UPDATE ON "identity_sessions", "tenant_sessions", "refresh_tokens", "authorization_codes" TO yebo_identity;
GRANT SELECT ON "users", "tenant_memberships", "tenant_domains" TO yebo_identity;

-- yebo_platform (resolvedor de dominios y health check): SOLO lectura de empresas y dominios.
GRANT SELECT ON "tenants", "tenant_domains" TO yebo_platform;
