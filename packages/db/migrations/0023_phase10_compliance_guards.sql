-- Compliance guards (Phase 10), enforced by the database itself as defence in
-- depth behind the compliance services (packages/db/src/compliance). These
-- tables are regulatory evidence kept 7 years:
--   1. Nothing is ever deleted or truncated.
--   2. daily_summary_versions, psp_statements, psp_statement_lines,
--      reconciliation_runs and reconciliation_mismatches are append-only.
--   3. An ELS report's record (outbox id, type, date, player, line, hash) never
--      changes; it moves pending → written once, and a written report is final.
--   4. A daily summary keeps its date and window; while provisional, new
--      figures need a higher version; once final it never changes.
--   5. An AML flag keeps its player, rule, window, severity and evidence; its
--      status moves open → reviewed | dismissed | escalated, escalated →
--      reviewed | dismissed, and reviewed or dismissed is final.

CREATE TRIGGER daily_summary_versions_append_only
  BEFORE UPDATE OR DELETE ON daily_summary_versions
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER psp_statements_append_only
  BEFORE UPDATE OR DELETE ON psp_statements
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER psp_statement_lines_append_only
  BEFORE UPDATE OR DELETE ON psp_statement_lines
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER reconciliation_runs_append_only
  BEFORE UPDATE OR DELETE ON reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER reconciliation_mismatches_append_only
  BEFORE UPDATE OR DELETE ON reconciliation_mismatches
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER els_reports_no_delete
  BEFORE DELETE ON els_reports
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER daily_summaries_no_delete
  BEFORE DELETE ON daily_summaries
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER aml_flags_no_delete
  BEFORE DELETE ON aml_flags
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER els_reports_no_truncate
  BEFORE TRUNCATE ON els_reports
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER daily_summaries_no_truncate
  BEFORE TRUNCATE ON daily_summaries
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER daily_summary_versions_no_truncate
  BEFORE TRUNCATE ON daily_summary_versions
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER psp_statements_no_truncate
  BEFORE TRUNCATE ON psp_statements
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER psp_statement_lines_no_truncate
  BEFORE TRUNCATE ON psp_statement_lines
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER reconciliation_runs_no_truncate
  BEFORE TRUNCATE ON reconciliation_runs
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER reconciliation_mismatches_no_truncate
  BEFORE TRUNCATE ON reconciliation_mismatches
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER aml_flags_no_truncate
  BEFORE TRUNCATE ON aml_flags
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_guard_els_report() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'written' THEN
    RAISE EXCEPTION 'ELS report % was written and is final', OLD.outbox_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.business_date IS DISTINCT FROM OLD.business_date
    OR NEW.player_ref IS DISTINCT FROM OLD.player_ref
    OR NEW.line IS DISTINCT FROM OLD.line
    OR NEW.hash IS DISTINCT FROM OLD.hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the record of ELS report % never changes', OLD.outbox_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'ELS report % attempts cannot go down', OLD.outbox_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER els_reports_guard
  BEFORE UPDATE ON els_reports
  FOR EACH ROW EXECUTE FUNCTION vamos_guard_els_report();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_guard_daily_summary() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'final' THEN
    RAISE EXCEPTION 'the daily summary of % is final', OLD.business_date
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.business_date IS DISTINCT FROM OLD.business_date
    OR NEW.window_start IS DISTINCT FROM OLD.window_start
    OR NEW.window_end IS DISTINCT FROM OLD.window_end THEN
    RAISE EXCEPTION 'the date of daily summary % never changes', OLD.business_date
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version < OLD.version
    OR (NEW.hash IS DISTINCT FROM OLD.hash AND NEW.version <= OLD.version) THEN
    RAISE EXCEPTION 'new figures of daily summary % need a new version', OLD.business_date
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM daily_summary_versions v
    WHERE v.business_date = NEW.business_date AND v.version = NEW.version AND v.hash = NEW.hash
  ) THEN
    RAISE EXCEPTION 'daily summary % version % is not recorded', NEW.business_date, NEW.version
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER daily_summaries_guard
  BEFORE UPDATE ON daily_summaries
  FOR EACH ROW EXECUTE FUNCTION vamos_guard_daily_summary();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_guard_aml_flag() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('reviewed', 'dismissed') THEN
    RAISE EXCEPTION 'AML flag % was % and is final', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.rule IS DISTINCT FROM OLD.rule
    OR NEW.severity IS DISTINCT FROM OLD.severity
    OR NEW.window_key IS DISTINCT FROM OLD.window_key
    OR NEW.details IS DISTINCT FROM OLD.details
    OR NEW.triggered_at IS DISTINCT FROM OLD.triggered_at
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the evidence of AML flag % never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (
    (OLD.status = 'open' AND NEW.status IN ('reviewed', 'dismissed', 'escalated'))
    OR (OLD.status = 'escalated' AND NEW.status IN ('reviewed', 'dismissed'))
  ) THEN
    RAISE EXCEPTION 'AML flag % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER aml_flags_guard
  BEFORE UPDATE ON aml_flags
  FOR EACH ROW EXECUTE FUNCTION vamos_guard_aml_flag();
