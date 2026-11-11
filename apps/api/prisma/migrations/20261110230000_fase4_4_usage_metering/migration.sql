-- Fase 4.4 · Medición de usuarios (billing §1–4, D5, ADR-016; decisiones del 2026-11-10).
--   membership_status_history (de tenant, RLS forzado): intervalos de cada membresía con sus factores de facturación.
--     La escriben TRIGGERS (SECURITY INVOKER: con el rol y el contexto de quien hace el cambio) en la MISMA
--     transacción que el cambio de la membresía o del usuario. Sin huecos ni solapes (EXCLUDE), sin fechas
--     retroactivas, sin DELETE y solo se cierra la fila vigente (trigger de guarda).
--   usage_daily_snapshots (de tenant, RLS forzado): valor de cada día terminado (FINAL, inmutable), escrito por el job
--     de medición con yebo_metering y el contexto de cada tenant (sin políticas entre tenants).
--   Las membresías existentes reciben su fila vigente desde el momento de esta migración: la medición empieza aquí.
--
-- Reversión (como yebo_owner; se pierde el historial de medición):
--   DROP TRIGGER "users_status_history" ON "users";
--   DROP TRIGGER "tenant_memberships_status_history" ON "tenant_memberships";
--   DROP TABLE "usage_daily_snapshots", "membership_status_history";
--   DROP FUNCTION "users_status_history"(), "tenant_memberships_status_history"(),
--                 "membership_status_history_guard"(), "usage_daily_snapshots_immutable"();
--   DROP TYPE "usage_snapshot_status";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261110230000_fase4_4_usage_metering';

-- CreateEnum
CREATE TYPE "usage_snapshot_status" AS ENUM ('PROVISIONAL', 'FINAL');

-- CreateTable
CREATE TABLE "membership_status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "membership_status" NOT NULL,
    "billable" BOOLEAN NOT NULL,
    "user_active" BOOLEAN NOT NULL,
    "effective_billable" BOOLEAN NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6),

    CONSTRAINT "membership_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_daily_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "usage_date" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "day_range" tstzrange NOT NULL,
    "peak_concurrent" INTEGER NOT NULL,
    "distinct_active" INTEGER NOT NULL,
    "status" "usage_snapshot_status" NOT NULL,
    "algorithm_version" INTEGER NOT NULL,
    "detail" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "usage_daily_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "membership_status_history_tenant_id_valid_from_idx" ON "membership_status_history"("tenant_id", "valid_from");

-- CreateIndex
CREATE INDEX "membership_status_history_membership_id_valid_to_idx" ON "membership_status_history"("membership_id", "valid_to");

-- CreateIndex
CREATE UNIQUE INDEX "membership_status_history_tenant_id_id_key" ON "membership_status_history"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_daily_snapshots_tenant_id_usage_date_key" ON "usage_daily_snapshots"("tenant_id", "usage_date");

-- CreateIndex
CREATE UNIQUE INDEX "usage_daily_snapshots_tenant_id_id_key" ON "usage_daily_snapshots"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "membership_status_history" ADD CONSTRAINT "membership_status_history_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "tenant_memberships"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "membership_status_history" ADD CONSTRAINT "membership_status_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_daily_snapshots" ADD CONSTRAINT "usage_daily_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ============================================================================
-- Invariantes
-- ============================================================================
ALTER TABLE "membership_status_history"
  -- Una fila cerrada en el mismo instante en que se abrió (dos cambios en una transacción) dura 0: rango vacío.
  ADD CONSTRAINT "membership_status_history_order" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
  -- billing §1: facturable = membresía ACTIVE ∧ billable ∧ usuario ACTIVE.
  ADD CONSTRAINT "membership_status_history_effective" CHECK (
    "effective_billable" = ("status" = 'ACTIVE' AND "billable" AND "user_active")),
  -- Sin huecos ni solapes por membresía (billing §2.1).
  ADD CONSTRAINT "membership_status_history_no_overlap" EXCLUDE USING gist (
    "membership_id" WITH =, tstzrange("valid_from", "valid_to", '[)') WITH &&);

ALTER TABLE "usage_daily_snapshots"
  ADD CONSTRAINT "usage_daily_snapshots_values" CHECK ("peak_concurrent" >= 0 AND "distinct_active" >= "peak_concurrent"
    AND "algorithm_version" >= 1),
  ADD CONSTRAINT "usage_daily_snapshots_detail_object" CHECK (jsonb_typeof("detail") = 'object');

-- ============================================================================
-- Guarda del historial (billing §2.1): sin fechas retroactivas, sin DELETE, solo se cierra la fila vigente.
-- SECURITY INVOKER (ADR-034: sin SECURITY DEFINER).
-- ============================================================================
CREATE FUNCTION "membership_status_history_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'membership_status_history: el historial no se borra' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.valid_from < now() - interval '1 minute' OR NEW.valid_from > clock_timestamp() + interval '1 minute' THEN
      RAISE EXCEPTION 'membership_status_history: valid_from lo fija el servidor (sin fechas retroactivas)'
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.valid_to IS NOT NULL THEN
      RAISE EXCEPTION 'membership_status_history: una fila nueva siempre está vigente' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: solo cerrar la fila vigente, ahora, sin tocar nada más.
  IF OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL
     AND NEW.valid_to >= now() - interval '1 minute'
     AND (to_jsonb(NEW) - 'valid_to') = (to_jsonb(OLD) - 'valid_to') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'membership_status_history: solo se cierra la fila vigente' USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER "membership_status_history_guard" BEFORE INSERT OR UPDATE OR DELETE ON "membership_status_history"
  FOR EACH ROW EXECUTE FUNCTION "membership_status_history_guard"();

-- ============================================================================
-- Escritura automática del historial en la misma transacción que el cambio (decisión del 2026-11-10).
-- ============================================================================
-- Membresía creada o con cambio de estado o de billable. El estado del usuario se arrastra de la fila vigente
-- (yebo_app no lee users); en un alta se lee de users (lo hace yebo_identity, que puede).
CREATE FUNCTION "tenant_memberships_status_history"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.billable IS NOT DISTINCT FROM OLD.billable THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT user_active INTO active FROM "membership_status_history"
     WHERE membership_id = NEW.id AND valid_to IS NULL;
  END IF;
  IF active IS NULL THEN
    SELECT u.status = 'ACTIVE' INTO STRICT active FROM "users" u WHERE u.id = NEW.user_id;
  END IF;
  UPDATE "membership_status_history" SET valid_to = now() WHERE membership_id = NEW.id AND valid_to IS NULL;
  INSERT INTO "membership_status_history"
    (tenant_id, membership_id, user_id, status, billable, user_active, effective_billable, valid_from)
  VALUES (NEW.tenant_id, NEW.id, NEW.user_id, NEW.status, NEW.billable, active,
          NEW.status = 'ACTIVE' AND NEW.billable AND active, now());
  RETURN NULL;
END $$;

CREATE TRIGGER "tenant_memberships_status_history" AFTER INSERT OR UPDATE OF "status", "billable" ON "tenant_memberships"
  FOR EACH ROW EXECUTE FUNCTION "tenant_memberships_status_history"();

-- Usuario habilitado o deshabilitado globalmente: afecta a TODAS sus membresías (billing §2.1). Recorre las empresas
-- fijando el contexto de cada una y lo restaura al final. Requiere leer las membresías de todas las empresas del
-- usuario (yebo_identity, por su política de lectura): solo ese rol puede cambiar users.status.
CREATE FUNCTION "users_status_history"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous text := current_setting('app.tenant_id', true);
  m record;
BEGIN
  FOR m IN SELECT id, tenant_id, status, billable FROM "tenant_memberships" WHERE user_id = NEW.id LOOP
    PERFORM set_config('app.tenant_id', m.tenant_id::text, true);
    UPDATE "membership_status_history" SET valid_to = now() WHERE membership_id = m.id AND valid_to IS NULL;
    INSERT INTO "membership_status_history"
      (tenant_id, membership_id, user_id, status, billable, user_active, effective_billable, valid_from)
    VALUES (m.tenant_id, m.id, NEW.id, m.status, m.billable, NEW.status = 'ACTIVE',
            m.status = 'ACTIVE' AND m.billable AND NEW.status = 'ACTIVE', now());
  END LOOP;
  PERFORM set_config('app.tenant_id', COALESCE(previous, ''), true);
  RETURN NULL;
END $$;

CREATE TRIGGER "users_status_history" AFTER UPDATE OF "status" ON "users"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION "users_status_history"();

-- Snapshots FINAL: definitivos (billing §4). Las correcciones van como ajustes en el período siguiente (4.5).
CREATE FUNCTION "usage_daily_snapshots_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'usage_daily_snapshots: un snapshot es definitivo' USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER "usage_daily_snapshots_immutable" BEFORE UPDATE OR DELETE ON "usage_daily_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "usage_daily_snapshots_immutable"();

-- ============================================================================
-- RLS forzado (ADR-003, ADR-025).
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['membership_status_history','usage_daily_snapshots']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ============================================================================
-- Fila vigente para las membresías existentes (el propietario también está sujeto al RLS forzado).
-- ============================================================================
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "membership_status_history"
      (tenant_id, membership_id, user_id, status, billable, user_active, effective_billable, valid_from)
    SELECT m.tenant_id, m.id, m.user_id, m.status, m.billable, u.status = 'ACTIVE',
           m.status = 'ACTIVE' AND m.billable AND u.status = 'ACTIVE', now()
      FROM "tenant_memberships" m JOIN "users" u ON u.id = m.user_id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- ============================================================================
-- Privilegios (ADR-034: lista blanca)
-- ============================================================================
-- Quien cambia membresías escribe el historial por el trigger (con su rol y contexto).
GRANT SELECT, INSERT ON "membership_status_history" TO yebo_app, yebo_identity;
GRANT UPDATE ("valid_to") ON "membership_status_history" TO yebo_app, yebo_identity;
-- yebo_metering (job): con el contexto de cada tenant; zona horaria y versión de plan para min_active_seconds.
GRANT SELECT ON "tenants", "membership_status_history", "subscriptions", "plan_versions" TO yebo_metering;
GRANT SELECT, INSERT ON "usage_daily_snapshots" TO yebo_metering;
-- yebo_backoffice (panel): consumo diario y el valor provisional del día en curso.
GRANT SELECT ON "membership_status_history", "usage_daily_snapshots" TO yebo_backoffice;
-- yebo_app (empresa, con RLS): su propio consumo diario («Obligaciones con YEBO», 4.5).
GRANT SELECT ON "usage_daily_snapshots" TO yebo_app;
