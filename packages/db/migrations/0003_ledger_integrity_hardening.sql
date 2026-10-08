-- Hardens the ledger guarantees of 0001 and guards the operating mode. With
-- this migration the database itself enforces:
--   1. ledger_entries, ledger_transactions and audit_log are append-only
--      (UPDATE, DELETE and TRUNCATE are rejected). A transaction's type and
--      created_at, which the responsible-gambling windows read, cannot be
--      rewritten.
--   2. Every ledger transaction has at least 2 entries and they sum to zero,
--      checked at COMMIT. This also covers a transaction inserted with no entries.
--   3. Every entry continues its account's running balance:
--      balance_after = previous entry's balance_after (0 for the first) + amount.
--   4. ledger_accounts.balance equals the account's latest balance_after (0
--      with no entries) at COMMIT. It is checked whenever an account is
--      created, its balance is written or an entry is added. With (3), the
--      cached balance always equals SUM(entries) and cannot change without an entry.
--   5. database_identity is written once. A database can only be marked
--      licensed when it holds no play money and no mock identity checks. A
--      licensed database refuses demo_topup transactions and the
--      house_demo_funding account.

CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_no_truncate
  BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_check_transaction_has_entries() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry_count integer;
BEGIN
  SELECT COUNT(*) INTO entry_count FROM ledger_entries WHERE transaction_id = NEW.id;
  IF entry_count < 2 THEN
    RAISE EXCEPTION 'ledger transaction % has % entries; at least 2 are required',
      NEW.id, entry_count USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_transactions_have_entries
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vamos_check_transaction_has_entries();
--> statement-breakpoint
-- Replaces the 0001 version, which only compared the cached balance with the
-- latest balance_after. The running-balance check is new.
CREATE OR REPLACE FUNCTION vamos_check_balance_after() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_balance bigint;
  previous_after bigint;
  latest_after bigint;
BEGIN
  SELECT balance_after INTO previous_after FROM ledger_entries
    WHERE account_id = NEW.account_id AND id < NEW.id ORDER BY id DESC LIMIT 1;
  IF NEW.balance_after IS DISTINCT FROM COALESCE(previous_after, 0) + NEW.amount THEN
    RAISE EXCEPTION
      'ledger entry % breaks the running balance of account %: balance_after % <> % + %',
      NEW.id, NEW.account_id, NEW.balance_after, COALESCE(previous_after, 0), NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;

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
CREATE OR REPLACE FUNCTION vamos_check_cached_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_balance bigint;
  latest_after bigint;
BEGIN
  SELECT balance INTO account_balance FROM ledger_accounts WHERE id = NEW.id;
  IF NOT FOUND THEN
    -- Deleted later in the same transaction (only possible without entries).
    RETURN NULL;
  END IF;
  SELECT balance_after INTO latest_after FROM ledger_entries
    WHERE account_id = NEW.id ORDER BY id DESC LIMIT 1;
  IF COALESCE(latest_after, 0) <> account_balance THEN
    RAISE EXCEPTION
      'ledger account % cached balance % does not match its entries (latest balance_after %)',
      NEW.id, account_balance, COALESCE(latest_after, 0) USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_accounts_balance_matches
  AFTER INSERT OR UPDATE OF balance ON ledger_accounts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vamos_check_cached_balance();
--> statement-breakpoint
CREATE TRIGGER database_identity_write_once
  BEFORE UPDATE OR DELETE ON database_identity
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER database_identity_no_truncate
  BEFORE TRUNCATE ON database_identity
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_check_licensed_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ledger_transactions WHERE type = 'demo_topup')
    OR EXISTS (SELECT 1 FROM ledger_accounts WHERE kind = 'house_demo_funding' AND balance <> 0)
  THEN
    RAISE EXCEPTION 'this database holds play money from demo mode and cannot be used in licensed mode'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM kyc_profiles WHERE provider = 'mock') THEN
    RAISE EXCEPTION 'this database holds identity checks made by the mock KYC provider and cannot be used in licensed mode'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER database_identity_licensed_claim
  BEFORE INSERT ON database_identity
  FOR EACH ROW WHEN (NEW.operating_mode = 'licensed')
  EXECUTE FUNCTION vamos_check_licensed_claim();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_reject_play_money_when_licensed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM database_identity WHERE operating_mode = 'licensed') THEN
    RAISE EXCEPTION 'play money is not allowed in a licensed database (% insert rejected)',
      TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_no_play_money_when_licensed
  BEFORE INSERT ON ledger_transactions
  FOR EACH ROW WHEN (NEW.type = 'demo_topup')
  EXECUTE FUNCTION vamos_reject_play_money_when_licensed();
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_no_play_money_when_licensed
  BEFORE INSERT ON ledger_accounts
  FOR EACH ROW WHEN (NEW.kind = 'house_demo_funding')
  EXECUTE FUNCTION vamos_reject_play_money_when_licensed();
