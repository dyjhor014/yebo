-- Fase 4.4 · Autor de cada cambio del historial de membresías (decisión del responsable, 2026-11-10).
--   changed_by_kind, changed_by_id y reason (data-dictionary §2). Cada servicio declara el autor en variables de la
--   TRANSACCIÓN (`app.actor_kind`, `app.actor_id`, `app.change_reason`, con set_config(..., true)) y los triggers
--   las leen. Un rol de ejecución que cambie una membresía o un usuario SIN declarar el autor se rechaza: un servicio
--   nuevo no puede olvidarlo. Solo el propietario (migraciones) y un rol con BYPASSRLS (pruebas, nunca en producción) quedan como SYSTEM.
--
-- Reversión (como yebo_owner): restaurar las dos funciones de 20261110230000_fase4_4_usage_metering y
--   ALTER TABLE "membership_status_history" DROP COLUMN "changed_by_kind", DROP COLUMN "changed_by_id",
--     DROP COLUMN "reason";
--   DROP TYPE "membership_change_actor";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261111000000_fase4_4_history_actor';

-- CreateEnum
CREATE TYPE "membership_change_actor" AS ENUM ('MEMBERSHIP', 'USER', 'PLATFORM_USER', 'SYSTEM');

-- AlterTable: las filas existentes son el arranque de la medición (SYSTEM).
ALTER TABLE "membership_status_history"
  ADD COLUMN "changed_by_kind" "membership_change_actor" NOT NULL DEFAULT 'SYSTEM',
  ADD COLUMN "changed_by_id" UUID,
  ADD COLUMN "reason" TEXT;
ALTER TABLE "membership_status_history" ALTER COLUMN "changed_by_kind" DROP DEFAULT;

ALTER TABLE "membership_status_history"
  ADD CONSTRAINT "membership_status_history_actor" CHECK (("changed_by_kind" = 'SYSTEM') = ("changed_by_id" IS NULL)),
  ADD CONSTRAINT "membership_status_history_reason_length" CHECK ("reason" IS NULL OR length("reason") <= 200);

-- El autor se lee DENTRO de cada función de trigger (las funciones de trigger no necesitan EXECUTE del rol que
-- hace el cambio; una función auxiliar sí, y ADR-034 no concede EXECUTE por defecto).
CREATE OR REPLACE FUNCTION "tenant_memberships_status_history"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  active boolean;
  kind "membership_change_actor";
  actor_id uuid;
  reason text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.billable IS NOT DISTINCT FROM OLD.billable THEN
    RETURN NULL;
  END IF;
  kind := NULLIF(current_setting('app.actor_kind', true), '')::"membership_change_actor";
  actor_id := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  reason := NULLIF(current_setting('app.change_reason', true), '');
  IF kind IS NULL THEN
    -- Exentos: el propietario (migraciones) y un rol con BYPASSRLS (solo existe en desarrollo y CI, ADR-034).
    IF current_user <> 'yebo_owner' AND NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
      RAISE EXCEPTION 'membership_status_history: el cambio no declara su autor (app.actor_kind)'
        USING ERRCODE = 'P0001';
    END IF;
    kind := 'SYSTEM';
  END IF;
  IF kind = 'SYSTEM' THEN
    actor_id := NULL;
  ELSIF actor_id IS NULL THEN
    RAISE EXCEPTION 'membership_status_history: el autor % no declara su id (app.actor_id)', kind
      USING ERRCODE = 'P0001';
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
    (tenant_id, membership_id, user_id, status, billable, user_active, effective_billable, valid_from,
     changed_by_kind, changed_by_id, reason)
  VALUES (NEW.tenant_id, NEW.id, NEW.user_id, NEW.status, NEW.billable, active,
          NEW.status = 'ACTIVE' AND NEW.billable AND active, now(), kind, actor_id, reason);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION "users_status_history"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous text := current_setting('app.tenant_id', true);
  m record;
  kind "membership_change_actor";
  actor_id uuid;
  reason text;
BEGIN
  kind := NULLIF(current_setting('app.actor_kind', true), '')::"membership_change_actor";
  actor_id := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  reason := NULLIF(current_setting('app.change_reason', true), '');
  IF kind IS NULL THEN
    -- Exentos: el propietario (migraciones) y un rol con BYPASSRLS (solo existe en desarrollo y CI, ADR-034).
    IF current_user <> 'yebo_owner' AND NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
      RAISE EXCEPTION 'membership_status_history: el cambio no declara su autor (app.actor_kind)'
        USING ERRCODE = 'P0001';
    END IF;
    kind := 'SYSTEM';
  END IF;
  IF kind = 'SYSTEM' THEN
    actor_id := NULL;
  ELSIF actor_id IS NULL THEN
    RAISE EXCEPTION 'membership_status_history: el autor % no declara su id (app.actor_id)', kind
      USING ERRCODE = 'P0001';
  END IF;
  FOR m IN SELECT id, tenant_id, status, billable FROM "tenant_memberships" WHERE user_id = NEW.id LOOP
    PERFORM set_config('app.tenant_id', m.tenant_id::text, true);
    UPDATE "membership_status_history" SET valid_to = now() WHERE membership_id = m.id AND valid_to IS NULL;
    INSERT INTO "membership_status_history"
      (tenant_id, membership_id, user_id, status, billable, user_active, effective_billable, valid_from,
       changed_by_kind, changed_by_id, reason)
    VALUES (m.tenant_id, m.id, NEW.id, m.status, m.billable, NEW.status = 'ACTIVE',
            m.status = 'ACTIVE' AND m.billable AND NEW.status = 'ACTIVE', now(), kind, actor_id, reason);
  END LOOP;
  PERFORM set_config('app.tenant_id', COALESCE(previous, ''), true);
  RETURN NULL;
END $$;
