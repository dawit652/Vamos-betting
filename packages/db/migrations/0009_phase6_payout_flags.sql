DROP INDEX "payouts_due_idx";--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "flag_reason" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "flagged_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "payouts_flagged_idx" ON "payouts" USING btree ("flagged_at") WHERE "payouts"."flagged_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payouts_due_idx" ON "payouts" USING btree ("next_attempt_at") WHERE "payouts"."status" IN ('approved', 'processing') AND "payouts"."flagged_at" IS NULL;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_flag" CHECK (("payment_intents"."flag_reason" IS NULL) = ("payment_intents"."flagged_at" IS NULL));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_flag" CHECK (("payouts"."flag_reason" IS NULL) = ("payouts"."flagged_at" IS NULL));