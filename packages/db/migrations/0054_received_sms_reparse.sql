-- Re-parse: a message no parser could read (status 'unparsed', every parsed field NULL) may have
-- its parsed fields filled in once, after a parser was fixed, by the staff action that re-reads
-- its stored text. Everything else is as in 0044: what was received never changes, a parsed
-- message keeps its parsed fields, and a match is final.
CREATE OR REPLACE FUNCTION vamos_guard_received_sms() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  filling_parsed boolean := OLD.status = 'unparsed'
    AND OLD.reference IS NULL AND OLD.amount IS NULL AND OLD.direction IS NULL AND OLD.institution IS NULL;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.sender IS DISTINCT FROM OLD.sender
    OR NEW.raw_text IS DISTINCT FROM OLD.raw_text
    OR NEW.text_hash IS DISTINCT FROM OLD.text_hash
    OR NEW.received_at IS DISTINCT FROM OLD.received_at
    OR NEW.device_received_at IS DISTINCT FROM OLD.device_received_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NOT filling_parsed AND (
      NEW.institution IS DISTINCT FROM OLD.institution
      OR NEW.direction IS DISTINCT FROM OLD.direction
      OR NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW.reference IS DISTINCT FROM OLD.reference
      OR NEW.counterparty_name IS DISTINCT FROM OLD.counterparty_name
      OR NEW.counterparty_phone IS DISTINCT FROM OLD.counterparty_phone
      OR NEW.balance IS DISTINCT FROM OLD.balance
      OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at))
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
