-- Fase 3.3 · Autorización y estado del tenant.
--
-- 1. Catálogo inicial de permisos y plantilla de rol Administrador (decisión del 2026-11-10: solo lo que existe,
--    la gestión de accesos). Fuente en código: src/modules/access/permission-catalog.ts; una prueba de integración
--    compara ambos. Cada fase posterior añade sus permisos y plantillas con su propia migración.
-- 2. yebo_app puede cambiar SOLO status, permissions_version y updated_at de tenant_memberships, con RLS forzado
--    (política tenant_isolation): suspender y reactivar membresías y versionar permisos al cambiar roles, sin usar
--    yebo_platform. En la línea de ADR-034: permisos explícitos por columna con RLS activo.
--
-- Reversión (manual, como yebo_owner; no borra datos de tenants):
--   REVOKE UPDATE (status, permissions_version, updated_at) ON "tenant_memberships" FROM yebo_app;
--   -- Solo si ningún rol de tenant usa ya estos permisos o la plantilla:
--   DELETE FROM "role_templates" WHERE code = 'ADMIN';
--   DELETE FROM "permissions" WHERE code IN ('members.read','members.suspend','members.reactivate',
--     'members.sessions.revoke','roles.read','roles.assign');
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261110120000_fase3_3_access';

INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'members.read',            'ACCESS', 'Ver los miembros de la empresa',                      false, now()),
  (gen_random_uuid(), 'members.suspend',         'ACCESS', 'Suspender el acceso de un miembro',                   true,  now()),
  (gen_random_uuid(), 'members.reactivate',      'ACCESS', 'Reactivar el acceso de un miembro',                   true,  now()),
  (gen_random_uuid(), 'members.sessions.revoke', 'ACCESS', 'Cerrar las sesiones de un miembro en esta empresa',   true,  now()),
  (gen_random_uuid(), 'roles.read',              'ACCESS', 'Ver los roles de la empresa',                         false, now()),
  (gen_random_uuid(), 'roles.assign',            'ACCESS', 'Asignar roles a los miembros',                        true,  now())
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_templates" ("id", "code", "name", "permission_codes", "updated_at") VALUES
  (gen_random_uuid(), 'ADMIN', 'Administrador',
   ARRAY['members.read','members.suspend','members.reactivate','members.sessions.revoke','roles.read','roles.assign'],
   now())
ON CONFLICT ("code") DO NOTHING;

GRANT UPDATE ("status", "permissions_version", "updated_at") ON "tenant_memberships" TO yebo_app;
