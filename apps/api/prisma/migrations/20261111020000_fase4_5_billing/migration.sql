-- Fase 4.5 · Períodos, importe y cobro (billing §5–7; F4-Q1; decisiones del responsable del 2026-11-10).
--   plan_versions: payment_terms_days (vencimiento = emisión + N días, por defecto 7) y tax_rate (0 hasta validar S5).
--   De tenant (RLS forzado): billing_periods, usage_period_calculations (inmutable), platform_invoices (importes
--   inmutables; solo cambian estado y saldo), platform_invoice_lines (inmutables) y subscription_payments.
--   Cierre de períodos: job con yebo_metering y el contexto de cada tenant. Pagos y vencimientos: yebo_backoffice.
--   Los períodos que empiezan en prueba se calculan pero no facturan.
--
-- Reversión (como yebo_owner; se pierden períodos, cálculos, facturas y pagos):
--   DROP TABLE "subscription_payments", "platform_invoice_lines", "platform_invoices", "usage_period_calculations",
--              "billing_periods";
--   DROP FUNCTION "billing_append_only"(), "billing_periods_guard"(), "platform_invoices_guard"();
--   DROP TYPE "payment_status", "payment_method", "invoice_line_kind", "invoice_status", "billing_period_status";
--   ALTER TABLE "plan_versions" DISABLE TRIGGER "plan_versions_immutable";
--   ALTER TABLE "plan_versions" DROP COLUMN "payment_terms_days", DROP COLUMN "tax_rate";
--   ALTER TABLE "plan_versions" ENABLE TRIGGER "plan_versions_immutable";
--   -- Permiso billing.read: quitarlo de role_permissions (tenant a tenant), de la plantilla ADMIN y de permissions.
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261111020000_fase4_5_billing';

-- CreateEnum
CREATE TYPE "billing_period_status" AS ENUM ('OPEN', 'CLOSING', 'CLOSED');
CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'PARTIALLY_PAID', 'VOID', 'OVERDUE');
CREATE TYPE "invoice_line_kind" AS ENUM ('BASE', 'EXTRA_USERS', 'ADDON', 'ADJUSTMENT', 'CREDIT');
CREATE TYPE "payment_method" AS ENUM ('BANK_TRANSFER', 'CASH', 'CARD', 'OTHER');
CREATE TYPE "payment_status" AS ENUM ('CONFIRMED', 'REVERSED');

-- AlterTable: columnas con valor por defecto (no dispara el trigger de inmutabilidad de las versiones).
ALTER TABLE "plan_versions"
  ADD COLUMN "payment_terms_days" INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN "tax_rate" DECIMAL(5,4) NOT NULL DEFAULT 0;
ALTER TABLE "plan_versions"
  ADD CONSTRAINT "plan_versions_billing_terms" CHECK ("payment_terms_days" BETWEEN 0 AND 90
    AND "tax_rate" >= 0 AND "tax_rate" < 1);

-- CreateTable
CREATE TABLE "billing_periods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "is_trial" BOOLEAN NOT NULL,
    "status" "billing_period_status" NOT NULL DEFAULT 'OPEN',
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_periods_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "usage_period_calculations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "billing_period_id" UUID NOT NULL,
    "usage_metric" "usage_metric" NOT NULL,
    "daily_aggregation" "daily_aggregation" NOT NULL,
    "metric_value" INTEGER NOT NULL,
    "included_users" INTEGER NOT NULL,
    "extra_users" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "base_amount" DECIMAL(14,2) NOT NULL,
    "extra_user_price" DECIMAL(14,2) NOT NULL,
    "extra_amount" DECIMAL(14,2) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "tax_rate" DECIMAL(5,4) NOT NULL,
    "tax_amount" DECIMAL(14,2) NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "plan_version_snapshot" JSONB NOT NULL,
    "pricing" JSONB NOT NULL,
    "daily_series" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "usage_period_calculations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "billing_period_id" UUID,
    "status" "invoice_status" NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL,
    "fiscal_document_ref" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_invoice_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "kind" "invoice_line_kind" NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "platform_invoice_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" "payment_method" NOT NULL,
    "reference" TEXT NOT NULL,
    "paid_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by_platform_user_id" UUID NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'CONFIRMED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_periods_tenant_id_id_key" ON "billing_periods"("tenant_id", "id");
CREATE UNIQUE INDEX "billing_periods_subscription_id_period_start_key" ON "billing_periods"("subscription_id", "period_start");
CREATE INDEX "billing_periods_tenant_id_status_idx" ON "billing_periods"("tenant_id", "status");
CREATE UNIQUE INDEX "usage_period_calculations_tenant_id_billing_period_id_key" ON "usage_period_calculations"("tenant_id", "billing_period_id");
CREATE UNIQUE INDEX "usage_period_calculations_tenant_id_id_key" ON "usage_period_calculations"("tenant_id", "id");
CREATE UNIQUE INDEX "platform_invoices_code_key" ON "platform_invoices"("code");
CREATE UNIQUE INDEX "platform_invoices_tenant_id_billing_period_id_key" ON "platform_invoices"("tenant_id", "billing_period_id");
CREATE UNIQUE INDEX "platform_invoices_tenant_id_id_key" ON "platform_invoices"("tenant_id", "id");
CREATE INDEX "platform_invoices_tenant_id_status_idx" ON "platform_invoices"("tenant_id", "status");
CREATE UNIQUE INDEX "platform_invoice_lines_tenant_id_id_key" ON "platform_invoice_lines"("tenant_id", "id");
CREATE INDEX "platform_invoice_lines_invoice_id_idx" ON "platform_invoice_lines"("invoice_id");
CREATE UNIQUE INDEX "subscription_payments_tenant_id_id_key" ON "subscription_payments"("tenant_id", "id");
CREATE INDEX "subscription_payments_invoice_id_idx" ON "subscription_payments"("invoice_id");

-- AddForeignKey (compuestas: todo en el mismo tenant)
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_tenant_id_subscription_id_fkey" FOREIGN KEY ("tenant_id", "subscription_id") REFERENCES "subscriptions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "usage_period_calculations" ADD CONSTRAINT "usage_period_calculations_tenant_id_billing_period_id_fkey" FOREIGN KEY ("tenant_id", "billing_period_id") REFERENCES "billing_periods"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_tenant_id_billing_period_id_fkey" FOREIGN KEY ("tenant_id", "billing_period_id") REFERENCES "billing_periods"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "platform_invoice_lines" ADD CONSTRAINT "platform_invoice_lines_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "platform_invoices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "platform_invoices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_recorded_by_platform_user_id_fkey" FOREIGN KEY ("recorded_by_platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ============================================================================
-- Invariantes (CHECK)
-- ============================================================================
ALTER TABLE "billing_periods"
  ADD CONSTRAINT "billing_periods_order" CHECK ("period_end" > "period_start"),
  ADD CONSTRAINT "billing_periods_closed" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL));

ALTER TABLE "usage_period_calculations"
  ADD CONSTRAINT "usage_period_calculations_amounts" CHECK ("metric_value" >= 0 AND "included_users" >= 0
    AND "extra_users" = GREATEST(0, "metric_value" - "included_users")
    AND "extra_amount" = "extra_users" * "extra_user_price"
    AND "subtotal" = "base_amount" + "extra_amount"
    AND "total_amount" = "subtotal" + "tax_amount"
    AND "base_amount" >= 0 AND "extra_user_price" >= 0 AND "tax_amount" >= 0);

ALTER TABLE "platform_invoices"
  ADD CONSTRAINT "platform_invoices_code_format" CHECK ("code" ~ '^YB-[0-9]{6}-[0-9A-F]{8}$'),
  ADD CONSTRAINT "platform_invoices_amounts" CHECK ("total" = "subtotal" + "tax" AND "tax" >= 0
    AND "balance" >= 0 AND "balance" <= "total"),
  ADD CONSTRAINT "platform_invoices_dates" CHECK ("due_date" >= "issue_date"),
  -- Pagada ⇔ sin saldo; emitida, parcial o vencida ⇒ con saldo pendiente.
  ADD CONSTRAINT "platform_invoices_status_balance" CHECK (("status" <> 'PAID' OR "balance" = 0)
    AND ("status" NOT IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE') OR "balance" > 0)
    AND ("status" <> 'PARTIALLY_PAID' OR "balance" < "total"));

ALTER TABLE "platform_invoice_lines"
  ADD CONSTRAINT "platform_invoice_lines_amount" CHECK ("amount" = "quantity" * "unit_price" AND "quantity" >= 0),
  ADD CONSTRAINT "platform_invoice_lines_description" CHECK (length(btrim("description")) BETWEEN 1 AND 200);

ALTER TABLE "subscription_payments"
  ADD CONSTRAINT "subscription_payments_amount" CHECK ("amount" > 0),
  ADD CONSTRAINT "subscription_payments_reference" CHECK (length(btrim("reference")) BETWEEN 1 AND 120);

-- ============================================================================
-- Inmutabilidad (billing §6). SECURITY INVOKER.
-- ============================================================================
-- Cálculos y líneas: append-only.
CREATE FUNCTION "billing_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: es inmutable', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER "usage_period_calculations_immutable" BEFORE UPDATE OR DELETE ON "usage_period_calculations"
  FOR EACH ROW EXECUTE FUNCTION "billing_append_only"();
CREATE TRIGGER "platform_invoice_lines_immutable" BEFORE UPDATE OR DELETE ON "platform_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "billing_append_only"();
CREATE TRIGGER "subscription_payments_no_delete" BEFORE DELETE ON "subscription_payments"
  FOR EACH ROW EXECUTE FUNCTION "billing_append_only"();

-- Períodos: OPEN → CLOSING → CLOSED, sin volver atrás; cerrado, nada cambia; nunca se borran.
CREATE FUNCTION "billing_periods_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'billing_periods: un período cerrado es inmutable y ninguno se borra' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'closed_at']) <> (to_jsonb(OLD) - ARRAY['status', 'closed_at'])
     OR NOT ((OLD.status = 'OPEN' AND NEW.status IN ('OPEN', 'CLOSING'))
          OR (OLD.status = 'CLOSING' AND NEW.status IN ('CLOSING', 'CLOSED'))) THEN
    RAISE EXCEPTION 'billing_periods: transición no permitida (%→%)', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "billing_periods_guard" BEFORE UPDATE OR DELETE ON "billing_periods"
  FOR EACH ROW EXECUTE FUNCTION "billing_periods_guard"();

-- Facturas: importes, fechas y período inmutables; solo cambian estado, saldo y updated_at; nunca se borran.
CREATE FUNCTION "platform_invoices_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform_invoices: una factura no se borra (se anula)' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'balance', 'updated_at'])
     <> (to_jsonb(OLD) - ARRAY['status', 'balance', 'updated_at']) THEN
    RAISE EXCEPTION 'platform_invoices: los importes y datos de una factura emitida son inmutables'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "platform_invoices_guard" BEFORE UPDATE OR DELETE ON "platform_invoices"
  FOR EACH ROW EXECUTE FUNCTION "platform_invoices_guard"();

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025).
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_periods','usage_period_calculations','platform_invoices','platform_invoice_lines',
                           'subscription_payments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ============================================================================
-- Permiso billing.read («Obligaciones con YEBO», BILLING_SELF; fuente: permission-catalog.ts)
-- ============================================================================
INSERT INTO "permissions" ("id", "code", "module_code", "description", "is_sensitive", "updated_at") VALUES
  (gen_random_uuid(), 'billing.read', 'ACCESS', 'Ver las obligaciones de la empresa con YEBO', false, now())
ON CONFLICT ("code") DO NOTHING;

UPDATE "role_templates" SET "permission_codes" = array_append("permission_codes", 'billing.read'), "updated_at" = now()
 WHERE "code" = 'ADMIN' AND NOT ('billing.read' = ANY ("permission_codes"));

-- Roles ya creados desde la plantilla Administrador (tenant a tenant por el RLS forzado). Sin cambiar membresías:
-- la versión de permisos se incrementa directamente (no dispara el historial de medición).
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_id")
      SELECT r.tenant_id, r.id, p.id
        FROM "roles" r JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
        CROSS JOIN "permissions" p
       WHERE p.code = 'billing.read'
      ON CONFLICT DO NOTHING;
    UPDATE "tenant_memberships" m SET "permissions_version" = m.permissions_version + 1, "updated_at" = now()
     WHERE EXISTS (SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                   JOIN "role_templates" rt ON rt.id = r.template_id AND rt.code = 'ADMIN'
                    WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- ============================================================================
-- Privilegios (ADR-034: lista blanca)
-- ============================================================================
-- yebo_metering (job de cierre): abre y cierra períodos, calcula, factura y avanza la suscripción.
GRANT SELECT, INSERT ON "billing_periods" TO yebo_metering;
GRANT UPDATE ("status", "closed_at") ON "billing_periods" TO yebo_metering;
GRANT SELECT, INSERT ON "usage_period_calculations", "platform_invoices", "platform_invoice_lines" TO yebo_metering;
GRANT UPDATE ("current_period_start", "current_period_end", "updated_at") ON "subscriptions" TO yebo_metering;
-- yebo_backoffice (panel): consulta todo; registra pagos; vencimientos (estado y saldo de las facturas).
GRANT SELECT ON "billing_periods", "usage_period_calculations", "platform_invoice_lines" TO yebo_backoffice;
GRANT SELECT ON "platform_invoices" TO yebo_backoffice;
GRANT UPDATE ("status", "balance", "updated_at") ON "platform_invoices" TO yebo_backoffice;
GRANT SELECT, INSERT ON "subscription_payments" TO yebo_backoffice;
-- yebo_app (empresa, con RLS): sus obligaciones con YEBO.
GRANT SELECT ON "billing_periods", "usage_period_calculations", "platform_invoices", "platform_invoice_lines",
  "subscription_payments" TO yebo_app;
