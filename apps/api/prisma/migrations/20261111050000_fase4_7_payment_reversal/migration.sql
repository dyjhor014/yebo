-- Fase 4.7b · Anulación de pagos registrados por el staff (decisiones del responsable del 2026-11-10):
--   cobros y superadmin (platform.billing.manage), motivo obligatorio, sin límite de tiempo. CONFIRMED → REVERSED es
--   final y no borra nada: el pago queda con quién, cuándo y por qué se anuló, y la factura recupera el saldo. Si la
--   factura queda vencida y la empresa estaba «Al día», vuelve a PAST_DUE (en la aplicación, misma transacción).
--
-- Reversión (como yebo_owner; se pierde quién anuló, cuándo y por qué; los pagos REVERSED siguen marcados):
--   DROP TRIGGER "subscription_payments_reversal_only" ON "subscription_payments";
--   DROP FUNCTION "subscription_payments_reversal_only"();
--   REVOKE UPDATE ("status", "reversed_at", "reversed_by_platform_user_id", "reversal_reason")
--     ON "subscription_payments" FROM yebo_backoffice;
--   ALTER TABLE "subscription_payments" DROP CONSTRAINT "subscription_payments_reversal",
--     DROP CONSTRAINT "subscription_payments_reversed_by_platform_user_id_fkey",
--     DROP COLUMN "reversal_reason", DROP COLUMN "reversed_at", DROP COLUMN "reversed_by_platform_user_id";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261111050000_fase4_7_payment_reversal';

-- AlterTable
ALTER TABLE "subscription_payments" ADD COLUMN     "reversal_reason" TEXT,
ADD COLUMN     "reversed_at" TIMESTAMPTZ(6),
ADD COLUMN     "reversed_by_platform_user_id" UUID;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_reversed_by_platform_user_id_fkey" FOREIGN KEY ("reversed_by_platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Anulado ⇔ con fecha, autor y motivo (3–500 caracteres); confirmado ⇔ sin ninguno.
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_reversal" CHECK (
  ("status" = 'REVERSED') = ("reversed_at" IS NOT NULL)
  AND ("reversed_at" IS NULL) = ("reversed_by_platform_user_id" IS NULL)
  AND ("reversed_at" IS NULL) = ("reversal_reason" IS NULL)
  AND ("reversal_reason" IS NULL OR length(btrim("reversal_reason")) BETWEEN 3 AND 500)
);

-- Lo único que cambia en un pago es su anulación: CONFIRMED → REVERSED, una vez, sin tocar el resto de la fila.
CREATE FUNCTION "subscription_payments_reversal_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'CONFIRMED' OR NEW.status <> 'REVERSED'
     OR (NEW.id, NEW.tenant_id, NEW.invoice_id, NEW.amount, NEW.method, NEW.reference, NEW.paid_at,
         NEW.recorded_by_platform_user_id, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.invoice_id, OLD.amount, OLD.method, OLD.reference, OLD.paid_at,
         OLD.recorded_by_platform_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'subscription_payments: solo se admite anular un pago confirmado' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "subscription_payments_reversal_only" BEFORE UPDATE ON "subscription_payments"
  FOR EACH ROW EXECUTE FUNCTION "subscription_payments_reversal_only"();

GRANT UPDATE ("status", "reversed_at", "reversed_by_platform_user_id", "reversal_reason")
  ON "subscription_payments" TO yebo_backoffice;
