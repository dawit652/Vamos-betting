ALTER TABLE "retail_tickets" ADD COLUMN "payout_code_hash" text;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "payout_code_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "payout_code_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_payout_attempts_non_negative" CHECK ("retail_tickets"."payout_code_attempts" >= 0);