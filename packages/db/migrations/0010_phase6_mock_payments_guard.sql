-- Payments made through the mock provider are play money, like demo top-ups.
-- This extends the operating-mode guard of 0003 to them (defence in depth
-- behind @vamos/config, which allows the mock provider only in demo mode):
--   1. A database cannot be claimed for licensed mode while it holds mock
--      payments: deposit intents or payouts of the mock provider, or its PSP
--      clearing account (house:psp:mock).
--   2. A licensed database refuses mock deposit intents, mock payouts and
--      the mock PSP clearing account.
-- The checks of 0003 (demo top-ups, demo funding, mock identity checks) are
-- unchanged.

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
  IF EXISTS (SELECT 1 FROM kyc_profiles WHERE provider = 'mock') THEN
    RAISE EXCEPTION 'this database holds identity checks made by the mock KYC provider and cannot be used in licensed mode'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_intents_no_mock_when_licensed
  BEFORE INSERT ON payment_intents
  FOR EACH ROW WHEN (NEW.provider = 'mock')
  EXECUTE FUNCTION vamos_reject_play_money_when_licensed();
--> statement-breakpoint
CREATE TRIGGER payouts_no_mock_when_licensed
  BEFORE INSERT ON payouts
  FOR EACH ROW WHEN (NEW.provider = 'mock')
  EXECUTE FUNCTION vamos_reject_play_money_when_licensed();
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_no_mock_psp_when_licensed
  BEFORE INSERT ON ledger_accounts
  FOR EACH ROW WHEN (NEW.kind = 'house_psp_clearing' AND NEW.provider = 'mock')
  EXECUTE FUNCTION vamos_reject_play_money_when_licensed();
