-- PRUEBA DE CONCEPTO (Fase 2): las FK creadas con SQL se sustituyen por FK declaradas en Prisma.
-- Motivo: Prisma Migrate elimina las FK que no están en el esquema (hallazgo de la PoC, ver ADR-024).
-- Migración no destructiva: no toca datos, solo reemplaza restricciones equivalentes.
-- RenameForeignKey
ALTER TABLE "inv_pool_allocations" RENAME CONSTRAINT "inv_pool_allocations_pool_fkey" TO "inv_pool_allocations_tenant_id_pool_id_fkey";

-- RenameForeignKey
ALTER TABLE "inv_pool_segment_usage" RENAME CONSTRAINT "inv_pool_segment_usage_pool_fkey" TO "inv_pool_segment_usage_tenant_id_pool_id_fkey";

-- RenameForeignKey
ALTER TABLE "inv_resource_allocations" RENAME CONSTRAINT "inv_resource_allocations_resource_fkey" TO "inv_resource_allocations_tenant_id_trip_resource_id_fkey";

-- RenameForeignKey
ALTER TABLE "inv_trip_resources" RENAME CONSTRAINT "inv_trip_resources_parent_fkey" TO "inv_trip_resources_tenant_id_parent_id_fkey";

