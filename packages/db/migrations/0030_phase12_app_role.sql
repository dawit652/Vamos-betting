-- Phase 12 security review I1: the role the api and worker connect as in production.
--
-- A superuser or the owner of the tables can switch every append-only trigger off
-- (SET session_replication_role = replica, ALTER TABLE ... DISABLE TRIGGER) and then rewrite the
-- ledger or the audit log. So only the one-shot migrate job (and the seed / admin CLI) connect as
-- the owner (POSTGRES_USER); the api and worker connect as vamos_app, which:
--   * is no superuser, owns nothing, cannot create roles or databases, bypasses no RLS;
--   * may read and write the ordinary tables (no TRUNCATE, REFERENCES or TRIGGER);
--   * may only INSERT and SELECT the append-only tables (no UPDATE / DELETE: the triggers
--     forbid them anyway, the missing privilege is the second lock), and may not DELETE from the
--     tables whose rows are only ever updated under a guard trigger.
-- The role is created NOLOGIN: the migrate job gives it LOGIN and its password from
-- APP_DB_PASSWORD (packages/db/src/app-role.ts). Idempotent, and safe when several databases of one
-- cluster are migrated at once (tests). Development and e2e may keep using the owner role.
--
-- A new table gets SELECT, INSERT, UPDATE, DELETE through the default privileges below. A new
-- append-only table must REVOKE in its own guard migration; packages/db/test/app-role.test.ts
-- fails otherwise.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vamos_app') THEN
    BEGIN
      CREATE ROLE vamos_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
        NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL; -- created meanwhile by a migration of another database in the cluster
    END;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO vamos_app', current_database());
END
$$;
--> statement-breakpoint
-- Nobody but the owner creates objects in the schema (the PostgreSQL 15+ default, made explicit
-- for databases created from an older template).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO vamos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vamos_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vamos_app;
--> statement-breakpoint
-- Append-only (BEFORE UPDATE OR DELETE triggers): insert and read only.
REVOKE UPDATE, DELETE ON
  ledger_entries,
  ledger_transactions,
  audit_log,
  database_identity,
  bet_cashouts,
  daily_summary_versions,
  psp_statements,
  psp_statement_lines,
  reconciliation_runs,
  reconciliation_mismatches
FROM vamos_app;
--> statement-breakpoint
-- Never deleted (BEFORE DELETE triggers; their updates are checked by guard triggers).
REVOKE DELETE ON
  jackpot_rounds,
  jackpot_games,
  jackpot_entries,
  els_reports,
  daily_summaries,
  aml_flags,
  inbound_messages,
  reconciliation_requests
FROM vamos_app;
--> statement-breakpoint
-- Tables and sequences that later migrations (run by this same owner) create.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vamos_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO vamos_app;
