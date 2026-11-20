ALTER TABLE "cash_operations" ADD COLUMN "original_printed_at" timestamp with time zone;--> statement-breakpoint
-- The original receipt is printed once: original_printed_at is set by the first print and never
-- changes afterwards (cleared, or moved), as the rest of a receipt never changes.
CREATE OR REPLACE FUNCTION vamos_cash_operation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.receipt_no, NEW.shift_id, NEW.shop_id, NEW.staff_id, NEW.user_id, NEW.kind,
      NEW.amount, NEW.payment_intent_id, NEW.payout_id, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.receipt_no, OLD.shift_id, OLD.shop_id, OLD.staff_id, OLD.user_id, OLD.kind,
      OLD.amount, OLD.payment_intent_id, OLD.payout_id, OLD.idempotency_key, OLD.created_at)
     OR NEW.reprints < OLD.reprints
     OR (OLD.original_printed_at IS NOT NULL
         AND NEW.original_printed_at IS DISTINCT FROM OLD.original_printed_at) THEN
    RAISE EXCEPTION 'cash operation % is a receipt: only its copies are counted', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
