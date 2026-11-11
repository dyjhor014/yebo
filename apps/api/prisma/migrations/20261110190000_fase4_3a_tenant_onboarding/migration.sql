-- Fase 4.3a · Alta de empresas y máquina de estados del tenant (multitenancy §5; data-dictionary §1; ADR-023, ADR-034).
--   De tenant (RLS forzado): tenant_settings (1:1), tenant_services, tenant_status_history (append-only) y
--   tenant_operation_overrides (excepción temporal de YEBO para USERS_ADD, decisión del 2026-11-10).
--   tenants.status_changed_at: inicio del estado vigente (días de gracia de PAST_DUE sin leer el historial).
-- Los escribe yebo_backoffice con el contexto del tenant fijado; yebo_app solo lee lo que necesita.
--
-- Reversión (como yebo_owner; solo si no hay empresas dadas de alta con este esquema):
--   DROP TABLE "tenant_operation_overrides", "tenant_status_history", "tenant_services", "tenant_settings";
--   DROP FUNCTION "tenant_status_history_append_only"();
--   DROP TYPE "tenant_operation_override_category", "transport_service", "service_modality";
--   ALTER TABLE "tenants" DROP COLUMN "status_changed_at";
--   REVOKE INSERT, UPDATE ON "tenants" FROM yebo_backoffice;
--   REVOKE INSERT ON "tenant_domains", "roles", "role_permissions" FROM yebo_backoffice;
--   REVOKE SELECT ON "tenant_domains", "roles", "role_templates", "permissions" FROM yebo_backoffice;
--   REVOKE INSERT, UPDATE ON "subscriptions" FROM yebo_backoffice;
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261110190000_fase4_3a_tenant_onboarding';

-- CreateEnum
CREATE TYPE "service_modality" AS ENUM ('LAND', 'RIVER');

-- CreateEnum
CREATE TYPE "transport_service" AS ENUM ('PASSENGER', 'PARCEL', 'CARGO', 'VEHICLE_TRANSPORT');

-- CreateEnum
CREATE TYPE "tenant_operation_override_category" AS ENUM ('USERS_ADD');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "status_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "tenant_settings" (
    "tenant_id" UUID NOT NULL,
    "require_delivery_pin" BOOLEAN NOT NULL DEFAULT false,
    "delivery_pin_max_attempts" INTEGER NOT NULL DEFAULT 5,
    "booking_hold_minutes" INTEGER NOT NULL DEFAULT 15,
    "allow_partial_payments" BOOLEAN NOT NULL DEFAULT false,
    "require_recipient_id_on_delivery" BOOLEAN NOT NULL DEFAULT true,
    "exceptional_delivery_enabled" BOOLEAN NOT NULL DEFAULT false,
    "exceptional_delivery_second_approval_threshold" DECIMAL(14,2),
    "exceptional_delivery_required_evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "public_tracking_show_recipient_initials" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "tenant_services" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "modality" "service_modality" NOT NULL,
    "service" "transport_service" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_status_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_status" "tenant_status",
    "to_status" "tenant_status" NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_platform_user_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_operation_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category" "tenant_operation_override_category" NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT NOT NULL,
    "granted_by_platform_user_id" UUID NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "ended_by_platform_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_operation_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_services_tenant_id_id_key" ON "tenant_services"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_services_tenant_id_modality_service_key" ON "tenant_services"("tenant_id", "modality", "service");

-- CreateIndex
CREATE INDEX "tenant_status_history_tenant_id_occurred_at_idx" ON "tenant_status_history"("tenant_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_status_history_tenant_id_id_key" ON "tenant_status_history"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "tenant_operation_overrides_tenant_id_category_idx" ON "tenant_operation_overrides"("tenant_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_operation_overrides_tenant_id_id_key" ON "tenant_operation_overrides"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_services" ADD CONSTRAINT "tenant_services_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_status_history" ADD CONSTRAINT "tenant_status_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_status_history" ADD CONSTRAINT "tenant_status_history_actor_platform_user_id_fkey" FOREIGN KEY ("actor_platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_operation_overrides" ADD CONSTRAINT "tenant_operation_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_operation_overrides" ADD CONSTRAINT "tenant_operation_overrides_granted_by_platform_user_id_fkey" FOREIGN KEY ("granted_by_platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_operation_overrides" ADD CONSTRAINT "tenant_operation_overrides_ended_by_platform_user_id_fkey" FOREIGN KEY ("ended_by_platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ============================================================================
-- Invariantes (CHECK)
-- ============================================================================
ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_ranges" CHECK ("delivery_pin_max_attempts" BETWEEN 1 AND 20
    AND "booking_hold_minutes" BETWEEN 1 AND 1440
    AND ("exceptional_delivery_second_approval_threshold" IS NULL OR "exceptional_delivery_second_approval_threshold" >= 0)),
  ADD CONSTRAINT "tenant_settings_settings_object" CHECK (jsonb_typeof("settings") = 'object');

ALTER TABLE "tenant_status_history"
  ADD CONSTRAINT "tenant_status_history_reason_present" CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  ADD CONSTRAINT "tenant_status_history_changes" CHECK ("from_status" IS DISTINCT FROM "to_status");

ALTER TABLE "tenant_operation_overrides"
  -- Temporal por definición (multitenancy §5.2, nota 2): fin obligatorio y como mucho 30 días.
  ADD CONSTRAINT "tenant_operation_overrides_window" CHECK ("valid_to" > "valid_from"
    AND "valid_to" <= "valid_from" + interval '30 days'),
  ADD CONSTRAINT "tenant_operation_overrides_reason_present" CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  ADD CONSTRAINT "tenant_operation_overrides_ended_consistent" CHECK (("ended_at" IS NULL) = ("ended_by_platform_user_id" IS NULL));

-- ============================================================================
-- Historial de estados: append-only también para el propietario de la tabla (salvo TRUNCATE de mantenimiento).
-- ============================================================================
CREATE FUNCTION "tenant_status_history_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tenant_status_history es append-only' USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER "tenant_status_history_append_only" BEFORE UPDATE OR DELETE ON "tenant_status_history"
  FOR EACH ROW EXECUTE FUNCTION "tenant_status_history_append_only"();

-- ============================================================================
-- RLS forzado en las tablas de tenant (ADR-003, ADR-025).
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_settings','tenant_services','tenant_status_history','tenant_operation_overrides']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ============================================================================
-- Privilegios (ADR-034: lista blanca)
-- ============================================================================
-- yebo_backoffice: alta de empresas y transiciones de estado. Los datos de tenant, siempre con su contexto (RLS).
GRANT INSERT ON "tenants" TO yebo_backoffice;
GRANT UPDATE ("status", "status_changed_at", "trial_ends_at", "activated_at", "cancelled_at", "updated_at")
  ON "tenants" TO yebo_backoffice;
GRANT SELECT, INSERT ON "tenant_domains" TO yebo_backoffice;
GRANT SELECT, INSERT ON "tenant_settings", "tenant_services", "tenant_status_history" TO yebo_backoffice;
GRANT SELECT, INSERT, UPDATE ON "tenant_operation_overrides" TO yebo_backoffice;
GRANT INSERT ON "subscriptions" TO yebo_backoffice;
GRANT UPDATE ("status", "updated_at") ON "subscriptions" TO yebo_backoffice;
-- Roles de sistema desde las plantillas (security.md §2), en la misma transacción que el alta.
GRANT SELECT ON "role_templates", "permissions" TO yebo_backoffice;
GRANT SELECT, INSERT ON "roles" TO yebo_backoffice;
GRANT INSERT ON "role_permissions" TO yebo_backoffice;
-- yebo_app (solo lectura, con RLS): servicios (módulos efectivos), excepciones de operación (guard de estado), su
-- configuración y su historial de estados (visibles para la empresa).
GRANT SELECT ON "tenant_services", "tenant_operation_overrides", "tenant_settings", "tenant_status_history" TO yebo_app;
