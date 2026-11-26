-- Fase 6.4a · Layouts v2 (maqueta 6.4 aprobada por el responsable, 2026-11-11; docs/development/phase-6-plan.md):
--   hasta 6 pisos por layout, bodega incluida (lanchas de 2, 3 y hasta 4 pisos de pasajeros). El documento pasa a
--   schemaVersion 2 (escala del plano y medidas reales de cada piso en metros; zonas de pasajeros mixtas): eso se
--   valida en la API (LayoutDocumentSchema); aquí solo cambian los límites de pisos. No había layouts guardados.
--
-- Reversión (como yebo_owner; falla si ya hay un layout con más de 4 pisos):
--   ALTER TABLE "layout_versions" DROP CONSTRAINT "layout_versions_values", ADD CONSTRAINT "layout_versions_values"
--     CHECK (<la de 20261113030000_fase6_3_layouts, con "decks" BETWEEN 1 AND 4>);
--   ALTER TABLE "layout_zones" DROP CONSTRAINT "layout_zones_values", ADD CONSTRAINT "layout_zones_values"
--     CHECK (<la de la 6.3, con "deck" BETWEEN 0 AND 3>);
--   ALTER TABLE "layout_elements" DROP CONSTRAINT "layout_elements_values", ADD CONSTRAINT "layout_elements_values"
--     CHECK (<la de la 6.3, con "deck" BETWEEN 0 AND 3>);
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261114010000_fase6_4a_layouts_v2';

ALTER TABLE "layout_versions"
  DROP CONSTRAINT "layout_versions_values",
  ADD CONSTRAINT "layout_versions_values" CHECK ("version" > 0 AND "schema_version" >= 1
    AND "decks" BETWEEN 1 AND 6 AND ("total_persons" IS NULL OR "total_persons" BETWEEN 1 AND 5000)
    AND jsonb_typeof("document") = 'object' AND pg_column_size("document") <= 1048576
    AND jsonb_typeof("canvas") = 'array');

ALTER TABLE "layout_zones"
  DROP CONSTRAINT "layout_zones_values",
  ADD CONSTRAINT "layout_zones_values" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{0,11}$' AND "deck" BETWEEN 0 AND 5
    AND jsonb_typeof("geometry") = 'object');

ALTER TABLE "layout_elements"
  DROP CONSTRAINT "layout_elements_values",
  ADD CONSTRAINT "layout_elements_values" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{0,11}$' AND "deck" BETWEEN 0 AND 5
    AND "x" >= 0 AND "y" >= 0 AND "w" >= 1 AND "h" >= 1 AND "rotation" IN (0, 90, 180, 270)
    AND "capacity" BETWEEN 1 AND 12);
