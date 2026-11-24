CREATE TABLE "agent_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"tickets_sold" integer NOT NULL,
	"sold_stakes" bigint NOT NULL,
	"tickets_cancelled" integer NOT NULL,
	"cancelled_stakes" bigint NOT NULL,
	"tickets_settled" integer NOT NULL,
	"settled_stakes" bigint NOT NULL,
	"settled_payouts" bigint NOT NULL,
	"ggr" bigint NOT NULL,
	"tickets_paid" integer NOT NULL,
	"paid_amount" bigint NOT NULL,
	"tickets_expired" integer NOT NULL,
	"expired_amount" bigint NOT NULL,
	"player_deposits" integer NOT NULL,
	"player_cash_in" bigint NOT NULL,
	"player_withdrawals" integer NOT NULL,
	"player_cash_out" bigint NOT NULL,
	"balance_start" bigint NOT NULL,
	"balance_end" bigint NOT NULL,
	"commission_kind" "agent_commission_kind" NOT NULL,
	"commission_bps" integer NOT NULL,
	"commission" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_by" uuid,
	"paid_reference" text,
	CONSTRAINT "agent_statements_monday" CHECK (EXTRACT(ISODOW FROM "agent_statements"."week_start") = 1),
	CONSTRAINT "agent_statements_counts" CHECK ("agent_statements"."tickets_sold" >= 0 AND "agent_statements"."tickets_cancelled" >= 0 AND "agent_statements"."tickets_settled" >= 0 AND "agent_statements"."tickets_paid" >= 0 AND "agent_statements"."tickets_expired" >= 0 AND "agent_statements"."player_deposits" >= 0 AND "agent_statements"."player_withdrawals" >= 0),
	CONSTRAINT "agent_statements_amounts" CHECK ("agent_statements"."sold_stakes" >= 0 AND "agent_statements"."cancelled_stakes" >= 0 AND "agent_statements"."settled_stakes" >= 0 AND "agent_statements"."settled_payouts" >= 0 AND "agent_statements"."paid_amount" >= 0 AND "agent_statements"."expired_amount" >= 0 AND "agent_statements"."player_cash_in" >= 0 AND "agent_statements"."player_cash_out" >= 0 AND "agent_statements"."commission" >= 0),
	CONSTRAINT "agent_statements_ggr" CHECK ("agent_statements"."ggr" = "agent_statements"."settled_stakes" - "agent_statements"."settled_payouts"),
	CONSTRAINT "agent_statements_bps" CHECK ("agent_statements"."commission_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "agent_statements_paid" CHECK (("agent_statements"."paid_at" IS NULL) = ("agent_statements"."paid_by" IS NULL) AND ("agent_statements"."paid_at" IS NULL) = ("agent_statements"."paid_reference" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_statements" ADD CONSTRAINT "agent_statements_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_statements" ADD CONSTRAINT "agent_statements_paid_by_admin_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_statements_agent_week_uq" ON "agent_statements" USING btree ("agent_id","week_start");--> statement-breakpoint
-- A statement's figures never change once made; only the commission's payment is recorded, once
-- (paid_at, paid_by and paid_reference go from empty to set together).
CREATE OR REPLACE FUNCTION vamos_agent_statement_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.agent_id, NEW.week_start, NEW.tickets_sold, NEW.sold_stakes,
      NEW.tickets_cancelled, NEW.cancelled_stakes, NEW.tickets_settled, NEW.settled_stakes,
      NEW.settled_payouts, NEW.ggr, NEW.tickets_paid, NEW.paid_amount, NEW.tickets_expired,
      NEW.expired_amount, NEW.player_deposits, NEW.player_cash_in, NEW.player_withdrawals,
      NEW.player_cash_out, NEW.balance_start, NEW.balance_end, NEW.commission_kind,
      NEW.commission_bps, NEW.commission, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.agent_id, OLD.week_start, OLD.tickets_sold, OLD.sold_stakes,
      OLD.tickets_cancelled, OLD.cancelled_stakes, OLD.tickets_settled, OLD.settled_stakes,
      OLD.settled_payouts, OLD.ggr, OLD.tickets_paid, OLD.paid_amount, OLD.tickets_expired,
      OLD.expired_amount, OLD.player_deposits, OLD.player_cash_in, OLD.player_withdrawals,
      OLD.player_cash_out, OLD.balance_start, OLD.balance_end, OLD.commission_kind,
      OLD.commission_bps, OLD.commission, OLD.created_at)
     OR OLD.paid_at IS NOT NULL THEN
    RAISE EXCEPTION 'agent statement % is fixed: only its payment is recorded, once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_statements_guard BEFORE UPDATE ON "agent_statements"
  FOR EACH ROW EXECUTE FUNCTION vamos_agent_statement_guard();
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "agent_statements" FROM vamos_app;
