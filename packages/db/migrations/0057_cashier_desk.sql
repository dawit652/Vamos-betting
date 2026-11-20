CREATE TYPE "public"."cash_operation_kind" AS ENUM('deposit', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."cash_shift_status" AS ENUM('open', 'closed');--> statement-breakpoint
ALTER TYPE "public"."admin_role" ADD VALUE 'cashier';--> statement-breakpoint
CREATE TABLE "cash_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_no" bigserial NOT NULL,
	"shift_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "cash_operation_kind" NOT NULL,
	"amount" bigint NOT NULL,
	"payment_intent_id" uuid,
	"payout_id" uuid,
	"idempotency_key" text NOT NULL,
	"reprints" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cash_operations_amount_positive" CHECK ("cash_operations"."amount" > 0),
	CONSTRAINT "cash_operations_reprints_non_negative" CHECK ("cash_operations"."reprints" >= 0),
	CONSTRAINT "cash_operations_money_row" CHECK (("cash_operations"."kind" = 'deposit' AND "cash_operations"."payment_intent_id" IS NOT NULL AND "cash_operations"."payout_id" IS NULL) OR ("cash_operations"."kind" = 'withdrawal' AND "cash_operations"."payout_id" IS NOT NULL AND "cash_operations"."payment_intent_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "cashier_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"status" "cash_shift_status" DEFAULT 'open' NOT NULL,
	"opening_float" bigint NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"counted_cash" bigint,
	"expected_cash" bigint,
	"close_note" text,
	CONSTRAINT "cashier_shifts_float_non_negative" CHECK ("cashier_shifts"."opening_float" >= 0),
	CONSTRAINT "cashier_shifts_count_non_negative" CHECK ("cashier_shifts"."counted_cash" IS NULL OR "cashier_shifts"."counted_cash" >= 0),
	CONSTRAINT "cashier_shifts_closed" CHECK (("cashier_shifts"."status" = 'closed') = ("cashier_shifts"."closed_at" IS NOT NULL AND "cashier_shifts"."counted_cash" IS NOT NULL AND "cashier_shifts"."expected_cash" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cashier_shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"receipt_width_mm" integer DEFAULT 80 NOT NULL,
	"approval_threshold" bigint DEFAULT 1000000 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cashier_shops_code_format" CHECK ("cashier_shops"."code" ~ '^[a-z0-9-]{2,32}$'),
	CONSTRAINT "cashier_shops_receipt_width" CHECK ("cashier_shops"."receipt_width_mm" IN (58, 80)),
	CONSTRAINT "cashier_shops_threshold_positive" CHECK ("cashier_shops"."approval_threshold" > 0)
);
--> statement-breakpoint
ALTER TABLE "cash_operations" ADD CONSTRAINT "cash_operations_shift_id_cashier_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cashier_shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_operations" ADD CONSTRAINT "cash_operations_shop_id_cashier_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."cashier_shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_operations" ADD CONSTRAINT "cash_operations_staff_id_admin_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_operations" ADD CONSTRAINT "cash_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_operations" ADD CONSTRAINT "cash_operations_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_operations" ADD CONSTRAINT "cash_operations_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_shop_id_cashier_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."cashier_shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_staff_id_admin_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_operations_receipt_no_uq" ON "cash_operations" USING btree ("receipt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_operations_idempotency_uq" ON "cash_operations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_operations_intent_uq" ON "cash_operations" USING btree ("payment_intent_id") WHERE "cash_operations"."payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_operations_payout_uq" ON "cash_operations" USING btree ("payout_id") WHERE "cash_operations"."payout_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "cash_operations_shift_idx" ON "cash_operations" USING btree ("shift_id","created_at");--> statement-breakpoint
CREATE INDEX "cash_operations_user_idx" ON "cash_operations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cashier_shifts_open_staff_uq" ON "cashier_shifts" USING btree ("staff_id") WHERE "cashier_shifts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "cashier_shifts_shop_opened_idx" ON "cashier_shifts" USING btree ("shop_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cashier_shops_code_uq" ON "cashier_shops" USING btree ("code");--> statement-breakpoint
-- Receipts and shifts are records: never deleted by the application.
REVOKE DELETE ON cash_operations, cashier_shifts FROM vamos_app;--> statement-breakpoint
-- The first shop (owner, 17 Nov 2026: one shop to start; name, address and limits are edited in
-- the back office).
INSERT INTO "cashier_shops" ("code", "name") VALUES ('main', 'Nahubet') ON CONFLICT DO NOTHING;
