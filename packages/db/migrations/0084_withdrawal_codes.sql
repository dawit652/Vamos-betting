ALTER TABLE "cash_withdrawal_codes" ADD COLUMN "payout_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_withdrawal_codes" ADD COLUMN "amount" bigint;--> statement-breakpoint
ALTER TABLE "cash_withdrawal_codes" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cashier_shops" ADD COLUMN "withdrawal_code_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cashier_shops" ADD COLUMN "withdrawal_code_failure_day" date;--> statement-breakpoint
ALTER TABLE "cash_withdrawal_codes" ADD CONSTRAINT "cash_withdrawal_codes_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_withdrawal_codes_live_hash_uq" ON "cash_withdrawal_codes" USING btree ("code_hash") WHERE "cash_withdrawal_codes"."payout_id" IS NOT NULL AND "cash_withdrawal_codes"."used_at" IS NULL AND "cash_withdrawal_codes"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "cash_withdrawal_codes_live_expiry_idx" ON "cash_withdrawal_codes" USING btree ("expires_at") WHERE "cash_withdrawal_codes"."payout_id" IS NOT NULL AND "cash_withdrawal_codes"."used_at" IS NULL AND "cash_withdrawal_codes"."closed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "cash_withdrawal_codes" ADD CONSTRAINT "cash_withdrawal_codes_payout_amount" CHECK (("cash_withdrawal_codes"."payout_id" IS NULL) = ("cash_withdrawal_codes"."amount" IS NULL));