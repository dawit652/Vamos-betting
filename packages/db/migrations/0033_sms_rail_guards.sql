-- SMS deposit rail: defence in depth behind packages/db/src/payments/smsrail.ts.
--   1. A received SMS is evidence of money moving. It is never deleted or truncated, and what was
--      received (source, sender, text, its hash, the parsed fields, when it arrived) never
--      changes: only its handling (status, match, receipt check, resolution) moves.
--   2. A match, once made, is final: matched_intent_id / matched_user_id / flagged_intent_id may
--      be set once and never changed or cleared; a payout proposal is final once settled.
--   3. Payout accounts are removed by setting removed_at, never deleted, and the destination of
--      a saved account never changes (a new destination is a new row).
--   4. The app role may not DELETE either table.

CREATE TRIGGER received_sms_no_delete
  BEFORE DELETE ON received_sms
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER received_sms_no_truncate
  BEFORE TRUNCATE ON received_sms
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_guard_received_sms() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.sender IS DISTINCT FROM OLD.sender
    OR NEW.raw_text IS DISTINCT FROM OLD.raw_text
    OR NEW.text_hash IS DISTINCT FROM OLD.text_hash
    OR NEW.institution IS DISTINCT FROM OLD.institution
    OR NEW.direction IS DISTINCT FROM OLD.direction
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.reference IS DISTINCT FROM OLD.reference
    OR NEW.counterparty_name IS DISTINCT FROM OLD.counterparty_name
    OR NEW.counterparty_phone IS DISTINCT FROM OLD.counterparty_phone
    OR NEW.balance IS DISTINCT FROM OLD.balance
    OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
    OR NEW.received_at IS DISTINCT FROM OLD.received_at
    OR NEW.device_received_at IS DISTINCT FROM OLD.device_received_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'received_sms: what was received is immutable (id %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.matched_intent_id IS NOT NULL AND NEW.matched_intent_id IS DISTINCT FROM OLD.matched_intent_id)
    OR (OLD.matched_user_id IS NOT NULL AND NEW.matched_user_id IS DISTINCT FROM OLD.matched_user_id)
    OR (OLD.flagged_intent_id IS NOT NULL AND NEW.flagged_intent_id IS DISTINCT FROM OLD.flagged_intent_id)
  THEN
    RAISE EXCEPTION 'received_sms: a match is final (id %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'settled' AND NEW.proposed_payout_id IS DISTINCT FROM OLD.proposed_payout_id THEN
    RAISE EXCEPTION 'received_sms: a settlement proof is final (id %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('matched', 'settled', 'credited_by_staff') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'received_sms: status % is final (id %)', OLD.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER received_sms_guard
  BEFORE UPDATE ON received_sms
  FOR EACH ROW EXECUTE FUNCTION vamos_guard_received_sms();
--> statement-breakpoint
CREATE TRIGGER payout_accounts_no_delete
  BEFORE DELETE ON payout_accounts
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER payout_accounts_no_truncate
  BEFORE TRUNCATE ON payout_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_guard_payout_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.institution IS DISTINCT FROM OLD.institution
    OR NEW.account IS DISTINCT FROM OLD.account
    OR NEW.account_name IS DISTINCT FROM OLD.account_name
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at)
    OR (OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at)
  THEN
    RAISE EXCEPTION 'payout_accounts: a saved destination never changes (id %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payout_accounts_guard
  BEFORE UPDATE ON payout_accounts
  FOR EACH ROW EXECUTE FUNCTION vamos_guard_payout_account();
--> statement-breakpoint
REVOKE DELETE ON received_sms, payout_accounts FROM vamos_app;
--> statement-breakpoint
-- Operating-mode guard (behind @vamos/config, which runs the rail `simulated` in demo mode and
-- `live` only in licensed mode): SMS from the dev simulator credit play money, like mock
-- payments. A database holding any cannot be claimed for licensed mode, and a licensed database
-- refuses them.
CREATE OR REPLACE FUNCTION vamos_check_licensed_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ledger_transactions WHERE type = 'demo_topup')
    OR EXISTS (SELECT 1 FROM ledger_accounts WHERE kind = 'house_demo_funding' AND balance <> 0)
  THEN
    RAISE EXCEPTION 'this database holds play money from demo mode and cannot be used in licensed mode'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM ledger_accounts WHERE kind = 'house_psp_clearing' AND provider = 'mock')
    OR EXISTS (SELECT 1 FROM payment_intents WHERE provider = 'mock')
    OR EXISTS (SELECT 1 FROM payouts WHERE provider = 'mock')
  THEN
    RAISE EXCEPTION 'this database holds play-money payments of the mock payment provider and cannot be used in licensed mode'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM received_sms WHERE source = 'simulator') THEN
    RAISE EXCEPTION 'this database holds play-money SMS deposits from the dev simulator and cannot be used in licensed mode'
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
CREATE TRIGGER received_sms_no_simulator_when_licensed
  BEFORE INSERT ON received_sms
  FOR EACH ROW WHEN (NEW.source = 'simulator')
  EXECUTE FUNCTION vamos_reject_play_money_when_licensed();
