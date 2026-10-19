-- Reconciliation requests (Phase 12: "Run now" runs in the worker, off the
-- request path). Defence in depth behind packages/db/src/compliance/reconciliation.ts:
--   1. At most one request is queued or running at a time (staff runs are one
--      at a time; a second "Run now" answers 409 reconciliation_running).
--   2. Requests are never deleted or truncated (they are the audit trail of
--      who asked for which run).
--   3. Only the state moves: queued -> running | failed, running -> running
--      (a retried job) | done | failed; done and failed are final. What was
--      asked (day, staff member, ip, time) never changes.

CREATE UNIQUE INDEX reconciliation_requests_one_open
  ON reconciliation_requests ((true))
  WHERE status IN ('queued', 'running');
--> statement-breakpoint
CREATE TRIGGER reconciliation_requests_no_delete
  BEFORE DELETE ON reconciliation_requests
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER reconciliation_requests_no_truncate
  BEFORE TRUNCATE ON reconciliation_requests
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_guard_reconciliation_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.business_date IS DISTINCT FROM OLD.business_date
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
    OR NEW.ip IS DISTINCT FROM OLD.ip
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'reconciliation_requests: what was requested cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('done', 'failed') THEN
    RAISE EXCEPTION 'reconciliation_requests: request % is already %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'queued' AND NEW.status NOT IN ('queued', 'running', 'failed') THEN
    RAISE EXCEPTION 'reconciliation_requests: queued cannot become %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'reconciliation_requests: attempts cannot go down'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reconciliation_requests_guard
  BEFORE UPDATE ON reconciliation_requests
  FOR EACH ROW EXECUTE FUNCTION vamos_guard_reconciliation_request();
