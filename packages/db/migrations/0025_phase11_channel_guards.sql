-- SMS channel guards (Phase 11), enforced by the database itself as defence in
-- depth behind the channel services (packages/db/src/channels). An inbound
-- message is the evidence of what a player texted and what it did:
--   1. inbound_messages rows are never deleted or truncated.
--   2. Only the reply bookkeeping changes after the insert: reply_count may
--      only grow and last_reply_at may move; user_id may only be cleared (the
--      users FK is ON DELETE SET NULL). The text, sender, outcome, bet and
--      reply never change.

CREATE TRIGGER inbound_messages_no_delete
  BEFORE DELETE ON inbound_messages
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER inbound_messages_no_truncate
  BEFORE TRUNCATE ON inbound_messages
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_guard_inbound_message() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.aggregator IS DISTINCT FROM OLD.aggregator
    OR NEW.external_id IS DISTINCT FROM OLD.external_id
    OR NEW.phone IS DISTINCT FROM OLD.phone
    OR NEW.short_code IS DISTINCT FROM OLD.short_code
    OR NEW.text IS DISTINCT FROM OLD.text
    OR NEW.command IS DISTINCT FROM OLD.command
    OR NEW.outcome IS DISTINCT FROM OLD.outcome
    OR NEW.refusal_code IS DISTINCT FROM OLD.refusal_code
    OR NEW.bet_id IS DISTINCT FROM OLD.bet_id
    OR NEW.reply IS DISTINCT FROM OLD.reply
    OR NEW.received_at IS DISTINCT FROM OLD.received_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL)
    OR NEW.reply_count < OLD.reply_count THEN
    RAISE EXCEPTION 'inbound message % is evidence: only its reply count and time may change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inbound_messages_guard
  BEFORE UPDATE ON inbound_messages
  FOR EACH ROW EXECUTE FUNCTION vamos_guard_inbound_message();
