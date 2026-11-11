-- Fase 4.5 · Cambio de plan a mitad de período (decisión del responsable del 2026-11-10; sustituye la regla MVP de
-- billing §7 «el nuevo plan aplica desde el período siguiente» para los upgrades).
--   Upgrade: aplica DESDE EL DÍA en que se registra (módulos y límites al instante). El período en curso se corta ese
--     día (`billing_periods.cut_off`) y se cierra con la base prorrateada (días usados / días del período) más los
--     usuarios adicionales medidos en esos días; la suscripción nueva empieza ese día con su propio ciclo y se cobra a
--     su cierre, como cualquier otro período.
--   Downgrade: se programa (`subscriptions.next_plan_version_id`) y aplica desde el período siguiente.
--
-- Reversión (como yebo_owner; solo si no hay cambios de plan registrados): restaurar "billing_periods_guard" de
--   20261111020000_fase4_5_billing y
--   ALTER TABLE "billing_periods" DROP COLUMN "cut_off";
--   ALTER TABLE "subscriptions" DROP COLUMN "next_plan_version_id";
--   REVOKE INSERT ON "billing_periods" FROM yebo_backoffice;
--   REVOKE UPDATE ("cut_off") ON "billing_periods" FROM yebo_backoffice;
--   REVOKE UPDATE ("is_current", "next_plan_version_id") ON "subscriptions" FROM yebo_backoffice, yebo_metering;
--   REVOKE INSERT ON "subscriptions" FROM yebo_metering;
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261111030000_fase4_5_plan_change';

-- AlterTable
ALTER TABLE "billing_periods" ADD COLUMN "cut_off" DATE;
ALTER TABLE "subscriptions" ADD COLUMN "next_plan_version_id" UUID;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_next_plan_version_id_fkey" FOREIGN KEY ("next_plan_version_id") REFERENCES "plan_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Un corte siempre cae dentro del período (el mismo día del inicio = período sin días).
ALTER TABLE "billing_periods"
  ADD CONSTRAINT "billing_periods_cut_off" CHECK ("cut_off" IS NULL OR ("cut_off" >= "period_start" AND "cut_off" < "period_end"));
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_next_plan_differs" CHECK ("next_plan_version_id" IS NULL OR "next_plan_version_id" <> "plan_version_id");

-- Guarda de períodos: además del avance de estado, admite fijar el corte UNA vez mientras está OPEN.
CREATE OR REPLACE FUNCTION "billing_periods_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ignored text[] := ARRAY['status', 'closed_at'];
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'billing_periods: un período cerrado es inmutable y ninguno se borra' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.cut_off IS NULL AND OLD.status = 'OPEN' THEN
    ignored := array_append(ignored, 'cut_off');
  END IF;
  IF (to_jsonb(NEW) - ignored) <> (to_jsonb(OLD) - ignored)
     OR NOT ((OLD.status = 'OPEN' AND NEW.status IN ('OPEN', 'CLOSING'))
          OR (OLD.status = 'CLOSING' AND NEW.status IN ('CLOSING', 'CLOSED'))) THEN
    RAISE EXCEPTION 'billing_periods: transición no permitida (%→%)', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- Privilegios (ADR-034)
-- yebo_backoffice (upgrade en el panel): corta el período, sustituye la suscripción vigente y abre el período nuevo;
-- programa el downgrade.
GRANT INSERT ON "billing_periods" TO yebo_backoffice;
GRANT UPDATE ("cut_off") ON "billing_periods" TO yebo_backoffice;
GRANT UPDATE ("is_current", "next_plan_version_id") ON "subscriptions" TO yebo_backoffice;
-- yebo_metering (cierre): aplica el downgrade programado al empezar el período siguiente.
GRANT INSERT ON "subscriptions" TO yebo_metering;
GRANT UPDATE ("is_current", "next_plan_version_id") ON "subscriptions" TO yebo_metering;
