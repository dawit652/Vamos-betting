-- One person, several staff accounts (docs/plans/guest-slips-and-staff.md, GS8): an email is unique
-- per kind of account. The roles are compared as text inside an IMMUTABLE function because a fresh
-- database adds `cashier` and `agent_owner` earlier in the same migration run, and a new enum value
-- cannot be used before it is committed. Renaming a role would need a REINDEX.
CREATE FUNCTION "public"."admin_account_kind"("role" "public"."admin_role") RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT CASE WHEN "role"::text = 'agent_owner' THEN 'agent_owner' WHEN "role"::text = 'cashier' THEN 'cashier' ELSE 'staff' END $$;--> statement-breakpoint
ALTER TABLE "admin_users" DROP CONSTRAINT "admin_users_email_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_kind_uq" ON "admin_users" USING btree ("email",admin_account_kind("role"));