-- Jackpot guards (Phase 8), enforced by the database itself as defence in
-- depth behind the jackpot services (packages/db/src/jackpots):
--   1. Rounds, games and entries are never deleted or truncated.
--   2. A round is inserted scheduled or open; its terms (template, prices,
--      pool, closing time) never change; its status only moves scheduled →
--      open | cancelled, open → closed, closed → settled | cancelled, and a
--      settled or cancelled round is final. It settles (or is voided) only
--      once none of its entries is open.
--   3. A game is added only to a scheduled or open round without entries,
--      within the round's game count; afterwards only its result changes,
--      and not once the round is final.
--   4. An entry is inserted open, into an open round, with valid picks (one
--      array per game of 1 to 3 distinct '1' / 'X' / '2'), its combinations
--      the product of the pick counts and at most the round's maximum, its
--      cost combinations × the round's cost per combination, and its
--      `jackpot_entry` ledger transaction (key jackpot_entry:<user>:<key>,
--      ref the entry) taking exactly the cost from the player's cash.
--   5. An entry's terms never change; it settles once, from open, while its
--      round is closed: won only with its `jackpot_prize` transaction
--      (jackpot_prize:<id>) paying exactly the net to the player, the tax to
--      house_tax_payable and the gross out of house_jackpot; lost only
--      without a prize or refund; void only with its refund
--      (jackpot_refund:<id>) giving the player exactly the cost back out of
--      house_jackpot.

CREATE TRIGGER jackpot_rounds_no_delete
  BEFORE DELETE ON jackpot_rounds
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER jackpot_rounds_no_truncate
  BEFORE TRUNCATE ON jackpot_rounds
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER jackpot_games_no_delete
  BEFORE DELETE ON jackpot_games
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER jackpot_games_no_truncate
  BEFORE TRUNCATE ON jackpot_games
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER jackpot_entries_no_delete
  BEFORE DELETE ON jackpot_entries
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER jackpot_entries_no_truncate
  BEFORE TRUNCATE ON jackpot_entries
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
-- What the ledger transaction with this key, type and ref posted to the
-- accounts of one kind (and one player, when p_user is given); 0 if none.
CREATE OR REPLACE FUNCTION vamos_jackpot_posted(
  p_key text,
  p_type ledger_transaction_type,
  p_ref text,
  p_kind ledger_account_kind,
  p_user uuid
) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(e.amount), 0)::bigint
  FROM ledger_transactions t
  JOIN ledger_entries e ON e.transaction_id = t.id
  JOIN ledger_accounts a ON a.id = e.account_id
  WHERE t.idempotency_key = p_key
    AND t.type = p_type
    AND t.ref_id = p_ref
    AND a.kind = p_kind
    AND (p_user IS NULL OR a.user_id = p_user)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_check_jackpot_round() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('scheduled', 'open') THEN
      RAISE EXCEPTION 'a jackpot round is inserted scheduled or open (got %)', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.template_code IS DISTINCT FROM OLD.template_code
    OR NEW.game_count IS DISTINCT FROM OLD.game_count
    OR NEW.cost_per_combination IS DISTINCT FROM OLD.cost_per_combination
    OR NEW.max_combinations IS DISTINCT FROM OLD.max_combinations
    OR NEW.pool IS DISTINCT FROM OLD.pool
    OR NEW.terms IS DISTINCT FROM OLD.terms
    OR NEW.closes_at IS DISTINCT FROM OLD.closes_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'jackpot round %: its terms are frozen', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('settled', 'cancelled') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
      OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
      OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
      OR NEW.settlement IS DISTINCT FROM OLD.settlement
    THEN
      RAISE EXCEPTION 'jackpot round % is %: its settlement is final', OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'scheduled' AND NEW.status IN ('open', 'cancelled'))
      OR (OLD.status = 'open' AND NEW.status = 'closed')
      OR (OLD.status = 'closed' AND NEW.status IN ('settled', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'jackpot round %: % → % is not allowed', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('settled', 'cancelled')
      AND EXISTS (SELECT 1 FROM jackpot_entries e WHERE e.round_id = NEW.id AND e.status = 'open')
    THEN
      RAISE EXCEPTION 'jackpot round % still has open entries', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER jackpot_rounds_guard
  BEFORE INSERT OR UPDATE ON jackpot_rounds
  FOR EACH ROW EXECUTE FUNCTION vamos_check_jackpot_round();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_check_jackpot_game() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM jackpot_rounds r
      WHERE r.id = NEW.round_id
        AND r.status IN ('scheduled', 'open')
        AND NEW.position < r.game_count
    ) OR EXISTS (SELECT 1 FROM jackpot_entries e WHERE e.round_id = NEW.round_id) THEN
      RAISE EXCEPTION 'jackpot round %: game % cannot be added', NEW.round_id, NEW.position
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.round_id IS DISTINCT FROM OLD.round_id
    OR NEW.position IS DISTINCT FROM OLD.position
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.market_id IS DISTINCT FROM OLD.market_id
    OR NEW.home_selection_id IS DISTINCT FROM OLD.home_selection_id
    OR NEW.draw_selection_id IS DISTINCT FROM OLD.draw_selection_id
    OR NEW.away_selection_id IS DISTINCT FROM OLD.away_selection_id
  THEN
    RAISE EXCEPTION 'jackpot round %: game % is fixed', OLD.round_id, OLD.position
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.result IS DISTINCT FROM OLD.result OR NEW.resulted_at IS DISTINCT FROM OLD.resulted_at)
    AND EXISTS (
      SELECT 1 FROM jackpot_rounds r
      WHERE r.id = NEW.round_id AND r.status IN ('settled', 'cancelled')
    )
  THEN
    RAISE EXCEPTION 'jackpot round %: game % was settled on its result', OLD.round_id, OLD.position
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER jackpot_games_guard
  BEFORE INSERT OR UPDATE ON jackpot_games
  FOR EACH ROW EXECUTE FUNCTION vamos_check_jackpot_game();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_check_jackpot_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  round_status jackpot_round_status;
  round_games integer;
  round_cost bigint;
  round_max integer;
  game jsonb;
  product bigint := 1;
  entry_ref text := NEW.id::text;
  prize_key text := 'jackpot_prize:' || NEW.id::text;
  refund_key text := 'jackpot_refund:' || NEW.id::text;
BEGIN
  SELECT r.status, r.game_count, r.cost_per_combination, r.max_combinations
    INTO round_status, round_games, round_cost, round_max
    FROM jackpot_rounds r WHERE r.id = NEW.round_id;

  IF TG_OP = 'INSERT' THEN
    IF round_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'jackpot round % is not open for entries', NEW.round_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'a jackpot entry is inserted open (got %)', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(NEW.picks) <> 'array' OR jsonb_array_length(NEW.picks) <> round_games THEN
      RAISE EXCEPTION 'jackpot entry %: picks do not cover the % games', NEW.id, round_games
        USING ERRCODE = 'check_violation';
    END IF;
    FOR game IN SELECT value FROM jsonb_array_elements(NEW.picks) LOOP
      IF jsonb_typeof(game) <> 'array'
        OR jsonb_array_length(game) NOT BETWEEN 1 AND 3
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(game) p
          WHERE p.value NOT IN ('"1"'::jsonb, '"X"'::jsonb, '"2"'::jsonb)
        )
        OR (SELECT count(DISTINCT p.value) FROM jsonb_array_elements(game) p)
          <> jsonb_array_length(game)
      THEN
        RAISE EXCEPTION 'jackpot entry %: invalid picks %', NEW.id, game
          USING ERRCODE = 'check_violation';
      END IF;
      product := product * jsonb_array_length(game);
    END LOOP;
    IF product <> NEW.combinations OR NEW.combinations > round_max THEN
      RAISE EXCEPTION 'jackpot entry %: % combinations (picks give %, maximum %)',
        NEW.id, NEW.combinations, product, round_max USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.cost <> NEW.combinations::bigint * round_cost THEN
      RAISE EXCEPTION 'jackpot entry %: cost % is not % × %', NEW.id, NEW.cost,
        NEW.combinations, round_cost USING ERRCODE = 'check_violation';
    END IF;
    IF vamos_jackpot_posted(
      'jackpot_entry:' || NEW.user_id::text || ':' || NEW.idempotency_key,
      'jackpot_entry', entry_ref, 'player_cash', NEW.user_id
    ) <> -NEW.cost THEN
      RAISE EXCEPTION 'jackpot entry % has no payment of its cost', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.round_id IS DISTINCT FROM OLD.round_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.picks IS DISTINCT FROM OLD.picks
    OR NEW.combinations IS DISTINCT FROM OLD.combinations
    OR NEW.cost IS DISTINCT FROM OLD.cost
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.placed_at IS DISTINCT FROM OLD.placed_at
  THEN
    RAISE EXCEPTION 'jackpot entry %: its picks and cost are fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'open' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
      OR NEW.correct IS DISTINCT FROM OLD.correct
      OR NEW.best_correct IS DISTINCT FROM OLD.best_correct
      OR NEW.prize_gross IS DISTINCT FROM OLD.prize_gross
      OR NEW.prize_tax IS DISTINCT FROM OLD.prize_tax
      OR NEW.prize_net IS DISTINCT FROM OLD.prize_net
      OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
    THEN
      RAISE EXCEPTION 'jackpot entry % is %: its settlement is final', OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'open' THEN
    RETURN NEW;
  END IF;

  IF round_status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'jackpot entry % settles only while its round is closed (round is %)',
      OLD.id, round_status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'won' THEN
    IF vamos_jackpot_posted(prize_key, 'jackpot_prize', entry_ref, 'player_cash', NEW.user_id)
        <> NEW.prize_net
      OR vamos_jackpot_posted(prize_key, 'jackpot_prize', entry_ref, 'house_jackpot', NULL)
        <> -NEW.prize_gross
      OR vamos_jackpot_posted(prize_key, 'jackpot_prize', entry_ref, 'house_tax_payable', NULL)
        <> NEW.prize_tax
    THEN
      RAISE EXCEPTION 'jackpot entry %: its prize posting does not match % / % / %',
        OLD.id, NEW.prize_gross, NEW.prize_tax, NEW.prize_net USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'lost' THEN
    IF EXISTS (
      SELECT 1 FROM ledger_transactions t WHERE t.idempotency_key IN (prize_key, refund_key)
    ) THEN
      RAISE EXCEPTION 'jackpot entry % was paid; it cannot be lost', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'void' THEN
    IF vamos_jackpot_posted(refund_key, 'jackpot_entry', entry_ref, 'player_cash', NEW.user_id)
        <> OLD.cost
      OR vamos_jackpot_posted(refund_key, 'jackpot_entry', entry_ref, 'house_jackpot', NULL)
        <> -OLD.cost
      OR EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.idempotency_key = prize_key)
    THEN
      RAISE EXCEPTION 'jackpot entry %: its refund posting does not match its cost %',
        OLD.id, OLD.cost USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER jackpot_entries_guard
  BEFORE INSERT OR UPDATE ON jackpot_entries
  FOR EACH ROW EXECUTE FUNCTION vamos_check_jackpot_entry();
