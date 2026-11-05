-- Fase 2 · migración inicial: extensiones requeridas por el diseño aprobado.
--   btree_gist → restricciones de exclusión para inventario por tramos (ADR-007).
--   citext     → correos y dominios sin distinción de mayúsculas (users.email, tenant_domains.host).
-- Ambas son extensiones "trusted": el propietario de la base de datos puede crearlas sin superusuario.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
