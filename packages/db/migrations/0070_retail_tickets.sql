CREATE TYPE "public"."retail_ticket_status" AS ENUM('sold', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'house_retail_payable';--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'house_retail_cash';--> statement-breakpoint
ALTER TYPE "public"."ledger_transaction_type" ADD VALUE 'retail_ticket_cancel';--> statement-breakpoint
ALTER TYPE "public"."bet_channel" ADD VALUE 'shop';--> statement-breakpoint
ALTER TYPE "public"."bet_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "retail_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bet_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"customer_phone" text,
	"stake" bigint NOT NULL,
	"status" "retail_ticket_status" DEFAULT 'sold' NOT NULL,
	"sold_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"original_printed_at" timestamp with time zone,
	"reprints" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "retail_tickets_stake_positive" CHECK ("retail_tickets"."stake" > 0),
	CONSTRAINT "retail_tickets_reprints_non_negative" CHECK ("retail_tickets"."reprints" >= 0),
	CONSTRAINT "retail_tickets_cancelled" CHECK (("retail_tickets"."status" = 'cancelled') = ("retail_tickets"."cancelled_at" IS NOT NULL AND "retail_tickets"."cancelled_by" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "counter_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "ticket_limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_shop_id_cashier_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."cashier_shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_staff_id_admin_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_shift_id_cashier_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cashier_shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_cancelled_by_admin_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_tickets_bet_uq" ON "retail_tickets" USING btree ("bet_id");--> statement-breakpoint
CREATE INDEX "retail_tickets_shift_idx" ON "retail_tickets" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "retail_tickets_agent_sold_idx" ON "retail_tickets" USING btree ("agent_id","sold_at");--> statement-breakpoint
CREATE INDEX "retail_tickets_shop_sold_idx" ON "retail_tickets" USING btree ("shop_id","sold_at");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_counter_user_id_users_id_fk" FOREIGN KEY ("counter_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_counter_user_uq" ON "agents" USING btree ("counter_user_id") WHERE "agents"."counter_user_id" IS NOT NULL;--> statement-breakpoint
-- Shop tickets are records: never deleted by the application.
REVOKE DELETE ON retail_tickets FROM vamos_app;
