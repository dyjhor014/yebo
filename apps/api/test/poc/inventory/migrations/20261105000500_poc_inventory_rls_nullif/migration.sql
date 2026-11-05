-- PRUEBA DE CONCEPTO (Fase 2) · hallazgo PoC-1: tras usar set_config(..., true) en una conexión del pool,
-- current_setting('app.tenant_id', true) devuelve '' (no NULL) y ''::uuid lanza 22P02.
-- PROPUESTA (pendiente de aprobación): NULLIF(..., '') para que la ausencia de contexto dé SIEMPRE 0 filas.
-- Migración no destructiva: solo redefine las políticas.
ALTER POLICY tenant_isolation ON "inv_trips"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER POLICY tenant_isolation ON "inv_trip_resources"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER POLICY tenant_isolation ON "inv_resource_allocations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER POLICY tenant_isolation ON "inv_pools"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER POLICY tenant_isolation ON "inv_pool_segment_usage"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER POLICY tenant_isolation ON "inv_pool_allocations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
