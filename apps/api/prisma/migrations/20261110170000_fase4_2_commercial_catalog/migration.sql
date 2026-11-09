-- Fase 4.2 · Catálogo comercial (multitenancy §6; data-dictionary §1; ADR-010, ADR-034).
--   Globales (🌐): modules, plans, plan_versions (inmutables al publicarse) y plan_version_modules.
--   De tenant (RLS forzado): tenant_module_overrides y subscriptions (la suscripción la crea el alta de la 4.3).
-- Ningún precio se fija aquí: los planes los crea el superadmin. El catálogo de módulos se siembra desde
-- src/modules/access/module-catalog.ts (una prueba compara ambos).
--
-- Reversión (como yebo_owner; solo si no hay suscripciones ni planes que conservar):
--   DROP TABLE "subscriptions", "tenant_module_overrides", "plan_version_modules", "plan_versions", "plans", "modules";
--   DROP FUNCTION "plan_versions_immutable"(), "plan_version_modules_immutable"();
--   DROP TYPE "subscription_status", "module_override_effect", "daily_aggregation", "usage_metric",
--             "billing_interval", "plan_version_status", "plan_status";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261110170000_fase4_2_commercial_catalog';

-- CreateEnum
CREATE TYPE "plan_status" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "plan_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "billing_interval" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "usage_metric" AS ENUM ('PEAK_DAILY', 'AVERAGE_DAILY', 'END_OF_PERIOD');

-- CreateEnum
CREATE TYPE "daily_aggregation" AS ENUM ('PEAK_CONCURRENT', 'DISTINCT_ACTIVE');

-- CreateEnum
CREATE TYPE "module_override_effect" AS ENUM ('GRANT', 'REVOKE');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "modules" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "plan_status" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_versions" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "plan_version_status" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "base_price" DECIMAL(14,2) NOT NULL,
    "billing_interval" "billing_interval" NOT NULL,
    "included_users" INTEGER NOT NULL,
    "extra_user_price" DECIMAL(14,2) NOT NULL,
    "usage_metric" "usage_metric" NOT NULL DEFAULT 'PEAK_DAILY',
    "daily_aggregation" "daily_aggregation" NOT NULL DEFAULT 'PEAK_CONCURRENT',
    "min_active_seconds" INTEGER NOT NULL DEFAULT 0,
    "trial_days" INTEGER NOT NULL DEFAULT 0,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "suspension_policy" JSONB NOT NULL DEFAULT '{}',
    "published_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_version_modules" (
    "plan_version_id" UUID NOT NULL,
    "module_id" UUID NOT NULL,
    "config" JSONB,

    CONSTRAINT "plan_version_modules_pkey" PRIMARY KEY ("plan_version_id","module_id")
);

-- CreateTable
CREATE TABLE "tenant_module_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "module_id" UUID NOT NULL,
    "effect" "module_override_effect" NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6),
    "reason" TEXT NOT NULL,
    "granted_by_platform_user_id" UUID NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "ended_by_platform_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_module_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "status" "subscription_status" NOT NULL,
    "current_period_start" DATE NOT NULL,
    "current_period_end" DATE NOT NULL,
    "cancel_at" TIMESTAMPTZ(6),
    "grace_until" TIMESTAMPTZ(6),
    "price_override" JSONB,
    "is_current" BOOLEAN,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "modules_code_key" ON "modules"("code");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "plan_versions_plan_id_version_key" ON "plan_versions"("plan_id", "version");

-- CreateIndex
CREATE INDEX "plan_version_modules_module_id_idx" ON "plan_version_modules"("module_id");

-- CreateIndex
CREATE INDEX "tenant_module_overrides_tenant_id_module_id_idx" ON "tenant_module_overrides"("tenant_id", "module_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_module_overrides_tenant_id_id_key" ON "tenant_module_overrides"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "subscriptions_plan_version_id_idx" ON "subscriptions"("plan_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenant_id_id_key" ON "subscriptions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenant_id_is_current_key" ON "subscriptions"("tenant_id", "is_current");

-- AddForeignKey
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "plan_version_modules" ADD CONSTRAINT "plan_version_modules_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "plan_version_modules" ADD CONSTRAINT "plan_version_modules_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_module_overrides" ADD CONSTRAINT "tenant_module_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_module_overrides" ADD CONSTRAINT "tenant_module_overrides_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_module_overrides" ADD CONSTRAINT "tenant_module_overrides_granted_by_platform_user_id_fkey" FOREIGN KEY ("granted_by_platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_module_overrides" ADD CONSTRAINT "tenant_module_overrides_ended_by_platform_user_id_fkey" FOREIGN KEY ("ended_by_platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ============================================================================
-- Invariantes (CHECK)
-- ============================================================================
ALTER TABLE "modules"
  ADD CONSTRAINT "modules_code_format" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,49}$');

ALTER TABLE "plans"
  ADD CONSTRAINT "plans_code_format" CHECK ("code" ~ '^[a-z0-9][a-z0-9-]{1,49}$'),
  ADD CONSTRAINT "plans_name_present" CHECK (length(btrim("name")) BETWEEN 1 AND 120);

ALTER TABLE "plan_versions"
  ADD CONSTRAINT "plan_versions_version_positive" CHECK ("version" >= 1),
  ADD CONSTRAINT "plan_versions_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "plan_versions_amounts_non_negative" CHECK ("base_price" >= 0 AND "extra_user_price" >= 0),
  ADD CONSTRAINT "plan_versions_counts_valid" CHECK ("included_users" >= 0 AND "min_active_seconds" >= 0
    AND "trial_days" BETWEEN 0 AND 365),
  ADD CONSTRAINT "plan_versions_json_objects" CHECK (jsonb_typeof("limits") = 'object'
    AND jsonb_typeof("suspension_policy") = 'object'),
  ADD CONSTRAINT "plan_versions_status_dates" CHECK (
    ("status" = 'DRAFT' AND "published_at" IS NULL AND "retired_at" IS NULL)
    OR ("status" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "retired_at" IS NULL)
    OR ("status" = 'RETIRED' AND "published_at" IS NOT NULL AND "retired_at" IS NOT NULL));

ALTER TABLE "tenant_module_overrides"
  ADD CONSTRAINT "tenant_module_overrides_window" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from"),
  ADD CONSTRAINT "tenant_module_overrides_reason_present" CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  ADD CONSTRAINT "tenant_module_overrides_ended_consistent" CHECK (("ended_at" IS NULL) = ("ended_by_platform_user_id" IS NULL));

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_is_current_true_or_null" CHECK ("is_current" IS NULL OR "is_current"),
  ADD CONSTRAINT "subscriptions_period_order" CHECK ("current_period_end" > "current_period_start"),
  ADD CONSTRAINT "subscriptions_price_override_object" CHECK ("price_override" IS NULL OR jsonb_typeof("price_override") = 'object');

-- ============================================================================
-- Inmutabilidad de las versiones publicadas (ADR-010). SECURITY INVOKER: sin privilegios propios.
-- ============================================================================
CREATE FUNCTION "plan_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'plan_versions: una versión publicada no se borra (ADR-010)' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  -- Publicada o retirada: solo PUBLISHED → RETIRED, sin tocar ningún otro campo.
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'
     AND (to_jsonb(NEW) - ARRAY['status','retired_at','updated_at']) = (to_jsonb(OLD) - ARRAY['status','retired_at','updated_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'plan_versions: una versión publicada es inmutable (ADR-010)' USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER "plan_versions_immutable" BEFORE UPDATE OR DELETE ON "plan_versions"
  FOR EACH ROW EXECUTE FUNCTION "plan_versions_immutable"();

CREATE FUNCTION "plan_version_modules_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_status "plan_version_status";
BEGIN
  SELECT status INTO version_status FROM "plan_versions"
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.plan_version_id ELSE NEW.plan_version_id END;
  IF version_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'plan_version_modules: los módulos de una versión publicada son inmutables (ADR-010)'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.plan_version_id <> NEW.plan_version_id THEN
    RAISE EXCEPTION 'plan_version_modules: no se mueve un módulo entre versiones' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER "plan_version_modules_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "plan_version_modules"
  FOR EACH ROW EXECUTE FUNCTION "plan_version_modules_immutable"();

-- ============================================================================
-- RLS forzado en las tablas de tenant (ADR-003, ADR-025).
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_module_overrides','subscriptions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ============================================================================
-- Catálogo de módulos (fuente: module-catalog.ts)
-- ============================================================================
INSERT INTO "modules" ("id", "code", "name", "description", "updated_at") VALUES
  (gen_random_uuid(), 'PASSENGERS', 'Pasajeros', 'Venta de pasajes, embarque y manifiestos', now()),
  (gen_random_uuid(), 'PARCELS', 'Encomiendas', 'Registro, traslado y entrega de encomiendas', now()),
  (gen_random_uuid(), 'CARGO', 'Carga', 'Cotización, contratación y entrega de carga', now()),
  (gen_random_uuid(), 'VEHICLE_TRANSPORT', 'Transporte de vehículos', 'Vehículos y maquinaria como carga especial', now()),
  (gen_random_uuid(), 'EINVOICING', 'Facturación electrónica', 'Emisión de comprobantes mediante la API externa', now()),
  (gen_random_uuid(), 'AGENCIES', 'Agencias externas', 'Agencias y canales con comisiones (D7)', now()),
  (gen_random_uuid(), 'OWNER_SETTLEMENTS', 'Liquidación a propietarios', 'Unidades de terceros y liquidaciones (D6)', now()),
  (gen_random_uuid(), 'WHITE_LABEL', 'Marca propia', 'Portal público con la identidad de la empresa', now()),
  (gen_random_uuid(), 'OFFLINE_OPS', 'Operación sin conexión', 'Dispositivos de embarque y almacén sin conexión', now())
ON CONFLICT ("code") DO NOTHING;

-- ============================================================================
-- Privilegios (ADR-034: lista blanca)
-- ============================================================================
-- yebo_backoffice (superadmin): catálogo y planes; excepciones con contexto de tenant (RLS); empresas en lectura.
GRANT SELECT ON "modules", "tenants" TO yebo_backoffice;
GRANT SELECT, INSERT, UPDATE ON "plans", "plan_versions", "tenant_module_overrides" TO yebo_backoffice;
GRANT SELECT, INSERT, DELETE ON "plan_version_modules" TO yebo_backoffice;
GRANT SELECT ON "subscriptions" TO yebo_backoffice;
-- yebo_app (API de empresas): lo necesario para calcular los módulos efectivos de su propio tenant (RLS).
GRANT SELECT ON "modules", "plan_version_modules", "subscriptions", "tenant_module_overrides" TO yebo_app;
