-- PRUEBA DE CONCEPTO (Fase 2): tablas generadas por Prisma + RLS forzado (ADR-003).


-- CreateTable
CREATE TABLE "poc_tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "poc_tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poc_routes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "poc_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poc_trips" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "code" TEXT NOT NULL,

    CONSTRAINT "poc_trips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "poc_routes_tenant_id_name_idx" ON "poc_routes"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "poc_routes_tenant_id_id_key" ON "poc_routes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "poc_trips_tenant_id_id_key" ON "poc_trips"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "poc_trips_tenant_id_code_key" ON "poc_trips"("tenant_id", "code");

-- AddForeignKey
ALTER TABLE "poc_routes" ADD CONSTRAINT "poc_routes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "poc_tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "poc_trips" ADD CONSTRAINT "poc_trips_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "poc_tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "poc_trips" ADD CONSTRAINT "poc_trips_tenant_id_route_id_fkey" FOREIGN KEY ("tenant_id", "route_id") REFERENCES "poc_routes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ============================================================================
-- Row Level Security (multitenancy §4.2)
-- ENABLE + FORCE: la política aplica incluso a dueños que no sean superusuario.
-- current_setting('app.tenant_id', true) devuelve NULL si no hay contexto → 0 filas (falla segura).
-- ============================================================================
ALTER TABLE "poc_routes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "poc_routes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "poc_routes"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "poc_trips" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "poc_trips" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "poc_trips"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Tabla global: la aplicación solo lee (la plataforma administra tenants).
REVOKE INSERT, UPDATE, DELETE ON "poc_tenants" FROM yebo_app;
