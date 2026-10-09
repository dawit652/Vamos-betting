ALTER TABLE "database_identity" ADD COLUMN "installation_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "job_key" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "settlement_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "events_resulted_idx" ON "events" USING btree ("resulted_at");--> statement-breakpoint
CREATE INDEX "bets_settlement_retry_idx" ON "bets" USING btree ("settlement_retry_at") WHERE "bets"."settlement_retry_at" IS NOT NULL;