-- Ledger integrity guarantees enforced by the database itself (defence in depth
-- on top of the LedgerService):
--   1. ledger_entries and audit_log are append-only.
--   2. Every ledger transaction's entries sum to zero, checked at COMMIT time.
--   3. ledger_accounts.balance always equals the account's latest balance_after.

CREATE OR REPLACE FUNCTION vamos_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_check_ledger_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total numeric;
  entry_count integer;
BEGIN
  SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO total, entry_count
    FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF entry_count < 2 THEN
    RAISE EXCEPTION 'ledger transaction % has % entries; at least 2 are required',
      NEW.transaction_id, entry_count USING ERRCODE = 'check_violation';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (sum = %)', NEW.transaction_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vamos_check_ledger_balanced();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_check_balance_after() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_balance bigint;
  latest_after bigint;
BEGIN
  SELECT balance INTO account_balance FROM ledger_accounts WHERE id = NEW.account_id;
  SELECT balance_after INTO latest_after FROM ledger_entries
    WHERE account_id = NEW.account_id ORDER BY id DESC LIMIT 1;
  IF latest_after IS DISTINCT FROM account_balance THEN
    RAISE EXCEPTION 'ledger account % cached balance % does not match latest entry balance %',
      NEW.account_id, account_balance, latest_after USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balance_matches
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vamos_check_balance_after();
