ALTER TYPE "public"."otp_purpose" ADD VALUE 'payout_account';--> statement-breakpoint
ALTER TYPE "public"."deposit_initiation_kind" ADD VALUE 'transfer';--> statement-breakpoint
CREATE TABLE "payout_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"institution" text NOT NULL,
	"account" text NOT NULL,
	"account_name" text NOT NULL,
	"verified_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "received_sms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"sender" text,
	"raw_text" text NOT NULL,
	"text_hash" text NOT NULL,
	"institution" text,
	"direction" text,
	"amount" bigint,
	"reference" text,
	"counterparty_name" text,
	"counterparty_phone" text,
	"balance" bigint,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"device_received_at" timestamp with time zone,
	"status" text NOT NULL,
	"status_reason" text,
	"matched_intent_id" uuid,
	"flagged_intent_id" uuid,
	"matched_user_id" uuid,
	"proposed_payout_id" uuid,
	"receipt_status" text,
	"receipt_reason" text,
	"receipt_checked_at" timestamp with time zone,
	"receipt_attempts" integer DEFAULT 0 NOT NULL,
	"receipt_receiver" text,
	"receipt_payer" text,
	"receipt_raw" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "received_sms_source" CHECK ("received_sms"."source" IN ('gateway', 'simulator', 'receipt')),
	CONSTRAINT "received_sms_status" CHECK ("received_sms"."status" IN ('unparsed', 'unmatched', 'ambiguous', 'matched', 'flagged', 'ignored_debit', 'settlement_proposed', 'settled', 'credited_by_staff', 'closed')),
	CONSTRAINT "received_sms_direction" CHECK ("received_sms"."direction" IS NULL OR "received_sms"."direction" IN ('credit', 'debit')),
	CONSTRAINT "received_sms_amount_positive" CHECK ("received_sms"."amount" IS NULL OR "received_sms"."amount" > 0),
	CONSTRAINT "received_sms_parsed" CHECK (("received_sms"."status" = 'unparsed') = ("received_sms"."reference" IS NULL) AND ("received_sms"."reference" IS NULL) = ("received_sms"."amount" IS NULL) AND ("received_sms"."reference" IS NULL) = ("received_sms"."direction" IS NULL)),
	CONSTRAINT "received_sms_receipt_status" CHECK ("received_sms"."receipt_status" IS NULL OR "received_sms"."receipt_status" IN ('verified', 'rejected', 'indeterminate', 'skipped')),
	CONSTRAINT "received_sms_credit_only_credits" CHECK ("received_sms"."matched_intent_id" IS NULL OR "received_sms"."direction" = 'credit'),
	CONSTRAINT "received_sms_debit_only_proposes" CHECK ("received_sms"."proposed_payout_id" IS NULL OR "received_sms"."direction" = 'debit'),
	CONSTRAINT "received_sms_raw_length" CHECK (length("received_sms"."raw_text") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD COLUMN "binding" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "requested_amount" bigint;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "payout_account_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "destination_institution" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "destination_account" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "destination_name" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "paying_by" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "settled_by" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "settlement_reference" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "settlement_sms_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "holder_name_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_sms" ADD CONSTRAINT "received_sms_matched_intent_id_payment_intents_id_fk" FOREIGN KEY ("matched_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_sms" ADD CONSTRAINT "received_sms_flagged_intent_id_payment_intents_id_fk" FOREIGN KEY ("flagged_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_sms" ADD CONSTRAINT "received_sms_matched_user_id_users_id_fk" FOREIGN KEY ("matched_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_sms" ADD CONSTRAINT "received_sms_proposed_payout_id_payouts_id_fk" FOREIGN KEY ("proposed_payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_accounts_user_account_uq" ON "payout_accounts" USING btree ("user_id","institution","account") WHERE "payout_accounts"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "payout_accounts_user_idx" ON "payout_accounts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "received_sms_text_hash_uq" ON "received_sms" USING btree ("text_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "received_sms_reference_uq" ON "received_sms" USING btree ("reference") WHERE "received_sms"."reference" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "received_sms_matched_intent_uq" ON "received_sms" USING btree ("matched_intent_id") WHERE "received_sms"."matched_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "received_sms_proposed_payout_uq" ON "received_sms" USING btree ("proposed_payout_id") WHERE "received_sms"."proposed_payout_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "received_sms_received_idx" ON "received_sms" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "received_sms_review_idx" ON "received_sms" USING btree ("received_at") WHERE "received_sms"."resolved_at" IS NULL AND ("received_sms"."status" IN ('unparsed', 'unmatched', 'ambiguous', 'flagged') OR "received_sms"."receipt_status" = 'rejected');--> statement-breakpoint
CREATE INDEX "received_sms_balance_chain_idx" ON "received_sms" USING btree ("institution","received_at") WHERE "received_sms"."balance" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "received_sms_receipt_due_idx" ON "received_sms" USING btree ("received_at") WHERE "received_sms"."receipt_status" IS NULL AND "received_sms"."status" = 'matched';--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_payout_account_id_payout_accounts_id_fk" FOREIGN KEY ("payout_account_id") REFERENCES "public"."payout_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_settlement_sms_id_received_sms_id_fk" FOREIGN KEY ("settlement_sms_id") REFERENCES "public"."received_sms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_sms_amount_open_uq" ON "payment_intents" USING btree ("amount") WHERE "payment_intents"."provider" = 'sms' AND "payment_intents"."status" IN ('created', 'pending');--> statement-breakpoint
CREATE INDEX "payment_intents_sms_open_idx" ON "payment_intents" USING btree ("amount") WHERE "payment_intents"."provider" = 'sms' AND "payment_intents"."status" IN ('created', 'pending', 'expired');--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_settlement_reference_uq" ON "payouts" USING btree ("settlement_reference") WHERE "payouts"."settlement_reference" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payouts_manual_queue_idx" ON "payouts" USING btree ("approved_at") WHERE "payouts"."manual" AND "payouts"."status" IN ('approved', 'processing');--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_requested_amount" CHECK ("payment_intents"."requested_amount" IS NULL OR ("payment_intents"."requested_amount" > 0 AND "payment_intents"."requested_amount" <= "payment_intents"."amount"));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_manual_four_eyes" CHECK (("payouts"."paying_by" IS NULL OR "payouts"."approved_by" IS NULL OR "payouts"."paying_by" <> "payouts"."approved_by") AND ("payouts"."settled_by" IS NULL OR "payouts"."approved_by" IS NULL OR "payouts"."settled_by" <> "payouts"."approved_by"));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_manual_destination" CHECK (NOT "payouts"."manual" OR ("payouts"."destination_institution" IS NOT NULL AND "payouts"."destination_account" IS NOT NULL AND "payouts"."payout_account_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_manual_paid" CHECK (NOT "payouts"."manual" OR "payouts"."status" <> 'paid' OR ("payouts"."settled_by" IS NOT NULL AND "payouts"."settlement_reference" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_manual_processing" CHECK (NOT "payouts"."manual" OR ("payouts"."status" = 'processing') = ("payouts"."paying_by" IS NOT NULL));