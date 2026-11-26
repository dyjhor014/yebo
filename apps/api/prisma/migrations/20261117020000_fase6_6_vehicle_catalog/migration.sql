-- Fase 6.6 · Catálogo de tipos de vehículo: Van y Camioneta pickup 4×4 (pedido del responsable, 2026-11-17).
--   Solo datos del catálogo global (sugerencias al crear un tipo): cada empresa sigue pudiendo crear tipos con
--   cualquier nombre. La pickup es la de la selva: asientos en la cabina y pasajeros y carga en la tolva.
--   Se reordenan los terrestres para que Van quede junto a Minivan y la pickup antes del camión; los fluviales
--   siguen detrás, en el mismo orden.
--
-- Reversión (como yebo_owner; solo si ninguna empresa creó un tipo desde estas sugerencias: la FK de
-- vehicle_types.catalog_code lo impide):
--   DELETE FROM "vehicle_type_catalog" WHERE "code" IN ('VAN', 'PICKUP');
--   UPDATE "vehicle_type_catalog" SET "sort_order" = v.o FROM (VALUES ('BUS', 1), ('MINIBUS', 2), ('MINIVAN', 3),
--     ('CAR', 4), ('TRUCK', 5), ('LANCHA', 6), ('MOTONAVE', 7), ('DESLIZADOR', 8), ('CHATA', 9), ('BOTE', 10))
--     AS v(c, o) WHERE "code" = v.c;
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261117020000_fase6_6_vehicle_catalog';

INSERT INTO "vehicle_type_catalog" ("code", "name", "modality", "sort_order") VALUES
  ('VAN', 'Van', 'LAND', 4),
  ('PICKUP', 'Camioneta pickup 4×4', 'LAND', 6);

UPDATE "vehicle_type_catalog" SET "sort_order" = v.o
  FROM (VALUES ('BUS', 1), ('MINIBUS', 2), ('MINIVAN', 3), ('CAR', 5), ('TRUCK', 7), ('LANCHA', 8),
               ('MOTONAVE', 9), ('DESLIZADOR', 10), ('CHATA', 11), ('BOTE', 12)) AS v(c, o)
 WHERE "code" = v.c;
