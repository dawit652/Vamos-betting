-- Cash-out guards (Phase 7), enforced by the database itself as defence in
-- depth behind the betting service (cashOutBet in @vamos/db):
--   1. bet_cashouts is append-only (no UPDATE, DELETE or TRUNCATE).
--   2. A bet becomes cashed_out only from open, and only once its
--      bet_cashouts row (same player, gross, tax and net) and its
--      `cashout:<bet id>` bet_cashout ledger transaction exist.
--   3. A cashed-out bet is final: its status, stake, settled amounts and
--      settlement version never change again, so no settlement, correction
--      or reversal can ever pay a cashed-out bet a second time.
--   4. No bet is inserted already cashed out.

CREATE TRIGGER bet_cashouts_append_only
  BEFORE UPDATE OR DELETE ON bet_cashouts
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER bet_cashouts_no_truncate
  BEFORE TRUNCATE ON bet_cashouts
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_check_bet_cash_out() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'a bet cannot be inserted cashed out (bet %)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'cashed_out' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.stake IS DISTINCT FROM OLD.stake
      OR NEW.settled_gross_payout IS DISTINCT FROM OLD.settled_gross_payout
      OR NEW.settled_tax IS DISTINCT FROM OLD.settled_tax
      OR NEW.settled_net_payout IS DISTINCT FROM OLD.settled_net_payout
      OR NEW.settlement_version IS DISTINCT FROM OLD.settlement_version
    THEN
      RAISE EXCEPTION 'bet % is cashed out: its status and amounts are final', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- NEW.status = 'cashed_out' (see the trigger's WHEN): the cash-out itself.
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'bet % is %: only an open bet can be cashed out', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM bet_cashouts c
    WHERE c.bet_id = NEW.id
      AND c.user_id = NEW.user_id
      AND c.gross = NEW.settled_gross_payout
      AND c.tax = NEW.settled_tax
      AND c.net = NEW.settled_net_payout
  ) THEN
    RAISE EXCEPTION 'bet % has no matching cash-out record', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ledger_transactions t
    WHERE t.idempotency_key = 'cashout:' || NEW.id::text
      AND t.type = 'bet_cashout'
  ) THEN
    RAISE EXCEPTION 'bet % has no cash-out ledger transaction', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bets_cash_out_guard
  BEFORE UPDATE ON bets
  FOR EACH ROW
  WHEN (OLD.status = 'cashed_out' OR NEW.status = 'cashed_out')
  EXECUTE FUNCTION vamos_check_bet_cash_out();
--> statement-breakpoint
CREATE TRIGGER bets_no_cashed_out_insert
  BEFORE INSERT ON bets
  FOR EACH ROW
  WHEN (NEW.status = 'cashed_out')
  EXECUTE FUNCTION vamos_check_bet_cash_out();
