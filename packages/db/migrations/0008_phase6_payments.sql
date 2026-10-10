CREATE TYPE "public"."deposit_initiation_kind" AS ENUM('push', 'redirect', 'ussd');--> statement-breakpoint
CREATE TYPE "public"."payment_event_kind" AS ENUM('deposit', 'payout');--> statement-breakpoint
CREATE TYPE "public"."payment_intent_status" AS ENUM('created', 'pending', 'succeeded', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('requested', 'approved', 'processing', 'paid', 'failed', 'rejected', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'house_withdrawals_pending';--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"kind" "payment_event_kind" NOT NULL,
	"provider_ref" text NOT NULL,
	"status" text NOT NULL,
	"amount" bigint,
	"currency" text,
	"intent_id" uuid,
	"payout_id" uuid,
	"outcome" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_events_target" CHECK ("payment_events"."intent_id" IS NULL OR "payment_events"."payout_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text DEFAULT 'ETB' NOT NULL,
	"phone" text NOT NULL,
	"status" "payment_intent_status" DEFAULT 'created' NOT NULL,
	"provider_ref" text,
	"initiation_kind" "deposit_initiation_kind",
	"redirect_url" text,
	"instructions" text,
	"idempotency_key" text NOT NULL,
	"failure_reason" text,
	"flag_reason" text,
	"flagged_at" timestamp with time zone,
	"ledger_transaction_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_intents_amount_positive" CHECK ("payment_intents"."amount" > 0),
	CONSTRAINT "payment_intents_provider_name" CHECK ("payment_intents"."provider" ~ '^[a-z0-9_-]{2,32}$'),
	CONSTRAINT "payment_intents_succeeded_ledger" CHECK (("payment_intents"."status" = 'succeeded') = ("payment_intents"."ledger_transaction_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text DEFAULT 'ETB' NOT NULL,
	"phone" text NOT NULL,
	"recipient_name" text NOT NULL,
	"status" "payout_status" NOT NULL,
	"review_reason" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"closed_by" text,
	"provider_ref" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"failure_reason" text,
	"idempotency_key" text NOT NULL,
	"hold_ledger_transaction_id" uuid NOT NULL,
	"paid_ledger_transaction_id" uuid,
	"reversal_ledger_transaction_id" uuid,
	"requested_at" timestamp with time zone NOT NULL,
	"processing_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payouts_amount_positive" CHECK ("payouts"."amount" > 0),
	CONSTRAINT "payouts_attempts_non_negative" CHECK ("payouts"."attempts" >= 0),
	CONSTRAINT "payouts_provider_name" CHECK ("payouts"."provider" ~ '^[a-z0-9_-]{2,32}$'),
	CONSTRAINT "payouts_paid_ledger" CHECK (("payouts"."status" = 'paid') = ("payouts"."paid_ledger_transaction_id" IS NOT NULL)),
	CONSTRAINT "payouts_reversal_ledger" CHECK (("payouts"."status" IN ('failed', 'rejected', 'cancelled')) = ("payouts"."reversal_ledger_transaction_id" IS NOT NULL)),
	CONSTRAINT "payouts_approved" CHECK ("payouts"."status" IN ('requested', 'rejected', 'cancelled') OR "payouts"."approved_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_uq" ON "payment_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "payment_events_intent_idx" ON "payment_events" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "payment_events_payout_idx" ON "payment_events" USING btree ("payout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_user_idempotency_uq" ON "payment_intents" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_provider_ref_uq" ON "payment_intents" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE INDEX "payment_intents_user_created_idx" ON "payment_intents" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_intents_open_expiry_idx" ON "payment_intents" USING btree ("expires_at") WHERE "payment_intents"."status" IN ('created', 'pending') AND "payment_intents"."flagged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "payment_intents_flagged_idx" ON "payment_intents" USING btree ("flagged_at") WHERE "payment_intents"."flagged_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_user_idempotency_uq" ON "payouts" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_provider_ref_uq" ON "payouts" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE INDEX "payouts_user_requested_idx" ON "payouts" USING btree ("user_id","requested_at");--> statement-breakpoint
CREATE INDEX "payouts_review_idx" ON "payouts" USING btree ("requested_at") WHERE "payouts"."status" = 'requested';--> statement-breakpoint
CREATE INDEX "payouts_due_idx" ON "payouts" USING btree ("next_attempt_at") WHERE "payouts"."status" IN ('approved', 'processing');