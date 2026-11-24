-- Cashier desk records (docs/plans/cashier-dashboard.md, review finding 7): a closed shift never
-- changes, and a receipt never changes except its count of copies (which only goes up).
CREATE OR REPLACE FUNCTION vamos_cashier_shift_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'cashier shift % is closed and cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cashier_shifts_closed_guard
  BEFORE UPDATE ON cashier_shifts
  FOR EACH ROW EXECUTE FUNCTION vamos_cashier_shift_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION vamos_cash_operation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.receipt_no, NEW.shift_id, NEW.shop_id, NEW.staff_id, NEW.user_id, NEW.kind,
      NEW.amount, NEW.payment_intent_id, NEW.payout_id, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.receipt_no, OLD.shift_id, OLD.shop_id, OLD.staff_id, OLD.user_id, OLD.kind,
      OLD.amount, OLD.payment_intent_id, OLD.payout_id, OLD.idempotency_key, OLD.created_at)
     OR NEW.reprints < OLD.reprints THEN
    RAISE EXCEPTION 'cash operation % is a receipt: only its copies are counted', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cash_operations_receipt_guard
  BEFORE UPDATE ON cash_operations
  FOR EACH ROW EXECUTE FUNCTION vamos_cash_operation_guard();
