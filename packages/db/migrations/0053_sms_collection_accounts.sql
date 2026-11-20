-- SMS rail: each collection account has its own space of exact amounts. Rows from before this keep a
-- null account (the index treats null as one account of its own), so the previous release, which never
-- sets it, sees the same uniqueness as before.
DROP INDEX "payment_intents_sms_amount_open_uq";--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "collection_account" text;--> statement-breakpoint
ALTER TABLE "received_sms" ADD COLUMN "collection_account" text;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_sms_amount_open_uq" ON "payment_intents" USING btree (coalesce("collection_account", ''),"amount") WHERE "payment_intents"."provider" = 'sms' AND "payment_intents"."status" IN ('created', 'pending');