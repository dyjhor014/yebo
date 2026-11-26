-- Fase 7.1 · Rutas y paradas (data-dictionary §5; plan de la Fase 7, F7-Q7 y F7-Q9, aprobadas el 2026-11-18).
--   routes: de tenant, con RLS forzado. Código único por empresa que no cambia; la modalidad tampoco. Nada se
--   borra: se archiva, porque los viajes y las tarifas referenciarán la ruta.
--   route_stops: las paradas en orden (seq desde 0) sobre las ubicaciones de la empresa. Al editar la ruta se
--   reemplazan enteras (DELETE + INSERT en una transacción): los viajes copian las paradas a trip_stops (7.3) y
--   nada referencia a una parada, así que yebo_app sí tiene DELETE aquí (no en routes).
--   Reglas de la ruta entera (seq 0..n-1 sin huecos, al menos 2 paradas, origen con 0 minutos y subida, destino con
--   bajada y sin traza, minutos crecientes, dos paradas seguidas distintas): trigger de restricción DIFERIDO, que
--   mira la ruta completa al confirmar la transacción.
--   path_to_next (F7-Q9): traza GeoJSON [[lng, lat], …] hasta la parada siguiente, de 2 a 2000 puntos. Su forma
--   fina (dentro del Perú, extremos cerca de sus paradas) la comprueba la API; la base, que sea un arreglo acotado.
--   Permiso routes.manage (plantilla Administrador).
--
-- Reversión (como yebo_owner; se pierden las rutas):
--   DROP TABLE "route_stops"; DROP TABLE "routes";
--   DROP FUNCTION "route_stops_check"();
--   -- Permiso routes.manage: quitarlo de role_permissions (tenant a tenant), de la plantilla ADMIN y de permissions.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261118010000_fase7_1_routes';

-- CreateTable
CREATE TABLE "routes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "modality" "service_modality" NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_stops" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "location_id" UUID NOT NULL,
    "offset_minutes" INTEGER NOT NULL,
    "dwell_minutes" INTEGER NOT NULL,
    "allows_boarding" BOOLEAN NOT NULL,
    "allows_alighting" BOOLEAN NOT NULL,
    "path_to_next" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_stops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "routes_tenant_id_id_key" ON "routes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "routes_tenant_id_code_key" ON "routes"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "route_stops_tenant_id_route_id_idx" ON "route_stops"("tenant_id", "route_id");

-- CreateIndex
CREATE INDEX "route_stops_tenant_id_location_id_idx" ON "route_stops"("tenant_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "route_stops_tenant_id_id_key" ON "route_stops"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "route_stops_route_id_seq_key" ON "route_stops"("route_id", "seq");

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_tenant_id_route_id_fkey" FOREIGN KEY ("tenant_id", "route_id") REFERENCES "routes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- ============================================================================
-- Reglas de cada fila
-- ============================================================================
ALTER TABLE "routes"
  ADD CONSTRAINT "routes_code" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{1,15}$'),
  ADD CONSTRAINT "routes_name" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 2 AND 80);

ALTER TABLE "route_stops"
  ADD CONSTRAINT "route_stops_seq" CHECK ("seq" BETWEEN 0 AND 49),
  -- Hasta 30 días desde el origen y 2 días de parada (contratos: ROUTE_MAX_OFFSET_MINUTES y ROUTE_MAX_DWELL_MINUTES).
  ADD CONSTRAINT "route_stops_offset" CHECK ("offset_minutes" BETWEEN 0 AND 43200),
  ADD CONSTRAINT "route_stops_dwell" CHECK ("dwell_minutes" BETWEEN 0 AND 2880),
  ADD CONSTRAINT "route_stops_path" CHECK (
    "path_to_next" IS NULL
    OR (jsonb_typeof("path_to_next") = 'array' AND jsonb_array_length("path_to_next") BETWEEN 2 AND 2000));

-- ============================================================================
-- Reglas de la ruta entera (trigger de restricción diferido: se comprueba al confirmar)
-- ============================================================================
CREATE FUNCTION "route_stops_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r_id uuid := COALESCE(NEW.route_id, OLD.route_id);
  n int;
  bad text;
BEGIN
  SELECT count(*) INTO n FROM "route_stops" WHERE route_id = r_id;
  IF n = 0 THEN
    -- Solo ocurre a mitad de un reemplazo que no se completa; una ruta nunca queda sin paradas.
    IF EXISTS (SELECT 1 FROM "routes" WHERE id = r_id) THEN
      RAISE EXCEPTION 'route_stops: una ruta tiene al menos origen y destino' USING ERRCODE = 'P0001';
    END IF;
    RETURN NULL;
  END IF;
  SELECT CASE
           WHEN n < 2 THEN 'una ruta tiene al menos origen y destino'
           WHEN bool_or(s.seq <> s.pos) THEN 'las paradas van de 0 a n-1, sin huecos'
           WHEN bool_or(s.pos = 0 AND (s.offset_minutes <> 0 OR NOT s.allows_boarding))
             THEN 'el origen tiene 0 minutos y permite subir'
           WHEN bool_or(s.pos = n - 1 AND (NOT s.allows_alighting OR s.path_to_next IS NOT NULL))
             THEN 'el destino permite bajar y no tiene traza'
           WHEN bool_or(s.pos > 0 AND s.offset_minutes <= s.prev_departure)
             THEN 'cada parada llega después de salir de la anterior'
           WHEN bool_or(s.pos > 0 AND s.location_id = s.prev_location)
             THEN 'dos paradas seguidas no son la misma ubicación'
           WHEN bool_or(s.pos > 0 AND s.pos < n - 1 AND NOT s.allows_boarding AND NOT s.allows_alighting)
             THEN 'una parada intermedia permite subir, bajar o ambas'
         END INTO bad
    FROM (SELECT seq, offset_minutes, allows_boarding, allows_alighting, path_to_next, location_id,
                 (row_number() OVER w - 1)::int AS pos,
                 lag(offset_minutes + dwell_minutes) OVER w AS prev_departure,
                 lag(location_id) OVER w AS prev_location
            FROM "route_stops" WHERE route_id = r_id
          WINDOW w AS (ORDER BY seq)) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'route_stops: %', bad USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "route_stops_check" AFTER INSERT OR UPDATE OR DELETE ON "route_stops"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "route_stops_check"();

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025)
-- ============================================================================
ALTER TABLE "routes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "routes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "routes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "route_stops" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "route_stops" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "route_stops"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============================================================================
-- Privilegios (ADR-034)
-- ============================================================================
-- yebo_app: la ruta no se borra y su código y modalidad no cambian; las paradas se reemplazan (sin UPDATE).
GRANT SELECT, INSERT ON "routes" TO yebo_app;
GRANT UPDATE ("name", "archived_at", "updated_at") ON "routes" TO yebo_app;
GRANT SELECT, INSERT, DELETE ON "route_stops" TO yebo_app;
-- yebo_backoffice: el panel de YEBO las ve.
GRANT SELECT ON "routes", "route_stops" TO yebo_backoffice;

-- ============================================================================
-- Permiso routes.manage (fuente: permission-catalog.ts)
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'routes.manage', 'ROUTES', 'Gestionar las rutas, sus paradas y sus trazas', false, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates" SET "permission_codes" = "permission_codes" || ARRAY['routes.manage']::text[],
       "updated_at" = now()
 WHERE "code" = 'ADMIN' AND NOT ('routes.manage' = ANY ("permission_codes"));

-- Roles ya creados desde la plantilla Administrador (tenant a tenant por el RLS forzado).
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
      SELECT r.tenant_id, r.id, p.id
        FROM "roles" r JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
        CROSS JOIN "permissions" p
       WHERE p.code = 'routes.manage'
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
