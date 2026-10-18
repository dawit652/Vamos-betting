CREATE TABLE "admin_login_throttles" (
	"admin_user_id" uuid NOT NULL,
	"client_key" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_login_throttles_admin_user_id_client_key_pk" PRIMARY KEY("admin_user_id","client_key"),
	CONSTRAINT "admin_login_throttles_failed_attempts" CHECK ("admin_login_throttles"."failed_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "password_change_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_pending_secret_enc" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_login_throttles" ADD CONSTRAINT "admin_login_throttles_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_created_idx" ON "users" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_ref_created_idx" ON "ledger_transactions" USING btree ("ref_type","created_at");--> statement-breakpoint
CREATE INDEX "payment_intents_succeeded_idx" ON "payment_intents" USING btree ("completed_at") WHERE "payment_intents"."status" = 'succeeded';--> statement-breakpoint
CREATE INDEX "payouts_requested_idx" ON "payouts" USING btree ("requested_at","id");--> statement-breakpoint
CREATE INDEX "payouts_paid_idx" ON "payouts" USING btree ("completed_at") WHERE "payouts"."status" = 'paid';--> statement-breakpoint
CREATE INDEX "jackpot_entries_placed_idx" ON "jackpot_entries" USING btree ("placed_at");--> statement-breakpoint
CREATE INDEX "jackpot_entries_settled_idx" ON "jackpot_entries" USING btree ("settled_at") WHERE "jackpot_entries"."settled_at" IS NOT NULL;