CREATE TABLE "cash_withdrawal_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cash_withdrawal_codes_attempts" CHECK ("cash_withdrawal_codes"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "cash_withdrawal_codes" ADD CONSTRAINT "cash_withdrawal_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_withdrawal_codes_user_idx" ON "cash_withdrawal_codes" USING btree ("user_id","created_at");