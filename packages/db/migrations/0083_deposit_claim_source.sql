ALTER TABLE "deposit_claims" ADD COLUMN "source" text DEFAULT 'app' NOT NULL;--> statement-breakpoint
CREATE INDEX "deposit_claims_telegram_idx" ON "deposit_claims" USING btree ("created_at") WHERE "deposit_claims"."source" = 'telegram';--> statement-breakpoint
ALTER TABLE "deposit_claims" ADD CONSTRAINT "deposit_claims_source" CHECK ("deposit_claims"."source" IN ('app', 'telegram'));