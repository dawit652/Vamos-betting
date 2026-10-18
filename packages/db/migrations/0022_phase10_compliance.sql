CREATE TYPE "public"."aml_flag_status" AS ENUM('open', 'reviewed', 'dismissed', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."aml_severity" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."daily_summary_status" AS ENUM('provisional', 'final');--> statement-breakpoint
CREATE TYPE "public"."els_report_status" AS ENUM('pending', 'written');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_run_kind" AS ENUM('scheduled', 'manual', 'psp_statement');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_run_status" AS ENUM('clean', 'mismatches', 'failed');--> statement-breakpoint
CREATE TABLE "aml_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"severity" "aml_severity" NOT NULL,
	"window_key" text NOT NULL,
	"status" "aml_flag_status" DEFAULT 'open' NOT NULL,
	"details" jsonb NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "aml_flags_review" CHECK (("aml_flags"."status" = 'open') = ("aml_flags"."reviewed_by" IS NULL AND "aml_flags"."reviewed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "compliance_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"position" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_summaries" (
	"business_date" date PRIMARY KEY NOT NULL,
	"status" "daily_summary_status" DEFAULT 'provisional' NOT NULL,
	"version" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"turnover" bigint NOT NULL,
	"bet_stakes" bigint NOT NULL,
	"bet_count" integer NOT NULL,
	"jackpot_stakes" bigint NOT NULL,
	"jackpot_entry_count" integer NOT NULL,
	"payouts" bigint NOT NULL,
	"won_payouts" bigint NOT NULL,
	"cash_outs" bigint NOT NULL,
	"refunds" bigint NOT NULL,
	"jackpot_prizes" bigint NOT NULL,
	"ggr" bigint NOT NULL,
	"tax_withheld" bigint NOT NULL,
	"bonuses" bigint NOT NULL,
	"deposits" bigint NOT NULL,
	"deposit_count" integer NOT NULL,
	"withdrawals" bigint NOT NULL,
	"withdrawal_count" integer NOT NULL,
	"active_players" integer NOT NULL,
	"commission_rate_bps" integer NOT NULL,
	"commission_due" bigint NOT NULL,
	"hash" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"finalized_by" text,
	CONSTRAINT "daily_summaries_version" CHECK ("daily_summaries"."version" >= 1),
	CONSTRAINT "daily_summaries_final" CHECK (("daily_summaries"."status" = 'final') = ("daily_summaries"."finalized_at" IS NOT NULL AND "daily_summaries"."finalized_by" IS NOT NULL)),
	CONSTRAINT "daily_summaries_window" CHECK ("daily_summaries"."window_end" = "daily_summaries"."window_start" + interval '1 day'),
	CONSTRAINT "daily_summaries_turnover" CHECK ("daily_summaries"."turnover" = "daily_summaries"."bet_stakes" + "daily_summaries"."jackpot_stakes"),
	CONSTRAINT "daily_summaries_payouts" CHECK ("daily_summaries"."payouts" = "daily_summaries"."won_payouts" + "daily_summaries"."cash_outs" + "daily_summaries"."refunds" + "daily_summaries"."jackpot_prizes"),
	CONSTRAINT "daily_summaries_ggr" CHECK ("daily_summaries"."ggr" = "daily_summaries"."turnover" - "daily_summaries"."payouts"),
	CONSTRAINT "daily_summaries_commission" CHECK ("daily_summaries"."commission_rate_bps" BETWEEN 0 AND 10000 AND "daily_summaries"."commission_due" >= 0 AND ("daily_summaries"."ggr" > 0 OR "daily_summaries"."commission_due" = 0) AND "daily_summaries"."commission_due" <= GREATEST("daily_summaries"."ggr", 0)),
	CONSTRAINT "daily_summaries_hash" CHECK ("daily_summaries"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "daily_summary_versions" (
	"business_date" date NOT NULL,
	"version" integer NOT NULL,
	"figures" jsonb NOT NULL,
	"hash" text NOT NULL,
	"reason" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"computed_by" text NOT NULL,
	CONSTRAINT "daily_summary_versions_business_date_version_pk" PRIMARY KEY("business_date","version"),
	CONSTRAINT "daily_summary_versions_version" CHECK ("daily_summary_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "els_reports" (
	"outbox_id" bigint PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"business_date" date NOT NULL,
	"player_ref" uuid,
	"line" text NOT NULL,
	"hash" text NOT NULL,
	"status" "els_report_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"written_at" timestamp with time zone,
	CONSTRAINT "els_reports_written" CHECK (("els_reports"."status" = 'written') = ("els_reports"."written_at" IS NOT NULL)),
	CONSTRAINT "els_reports_hash" CHECK ("els_reports"."hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "els_reports_attempts" CHECK ("els_reports"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "psp_statement_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"statement_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"provider" text NOT NULL,
	"reference" text NOT NULL,
	"amount" bigint NOT NULL,
	"business_date" date NOT NULL,
	"kind" text,
	"match_status" text NOT NULL,
	"record_kind" text,
	"record_id" uuid,
	"record_amount" bigint
);
--> statement-breakpoint
CREATE TABLE "psp_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"providers" text[] NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"file_name" text,
	"file_hash" text NOT NULL,
	"line_count" integer NOT NULL,
	"total_in" bigint NOT NULL,
	"total_out" bigint NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "psp_statements_period" CHECK ("psp_statements"."period_from" <= "psp_statements"."period_to"),
	CONSTRAINT "psp_statements_file_hash" CHECK ("psp_statements"."file_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "reconciliation_mismatches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"check" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"expected" text,
	"actual" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "reconciliation_run_kind" NOT NULL,
	"status" "reconciliation_run_status" NOT NULL,
	"business_date" date,
	"statement_id" uuid,
	"triggered_by" text NOT NULL,
	"checks" jsonb NOT NULL,
	"mismatch_count" integer NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reconciliation_runs_count" CHECK ("reconciliation_runs"."mismatch_count" >= 0),
	CONSTRAINT "reconciliation_runs_status" CHECK (("reconciliation_runs"."status" = 'clean') = ("reconciliation_runs"."mismatch_count" = 0 AND "reconciliation_runs"."error" IS NULL)),
	CONSTRAINT "reconciliation_runs_statement" CHECK (("reconciliation_runs"."kind" = 'psp_statement') = ("reconciliation_runs"."statement_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "aml_flags" ADD CONSTRAINT "aml_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summary_versions" ADD CONSTRAINT "daily_summary_versions_business_date_daily_summaries_business_date_fk" FOREIGN KEY ("business_date") REFERENCES "public"."daily_summaries"("business_date") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psp_statement_lines" ADD CONSTRAINT "psp_statement_lines_statement_id_psp_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."psp_statements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_mismatches" ADD CONSTRAINT "reconciliation_mismatches_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_statement_id_psp_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."psp_statements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aml_flags_user_rule_window_uq" ON "aml_flags" USING btree ("user_id","rule","window_key");--> statement-breakpoint
CREATE INDEX "aml_flags_status_idx" ON "aml_flags" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "aml_flags_created_idx" ON "aml_flags" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "aml_flags_user_idx" ON "aml_flags" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "daily_summaries_status_idx" ON "daily_summaries" USING btree ("status","business_date");--> statement-breakpoint
CREATE INDEX "els_reports_pending_idx" ON "els_reports" USING btree ("created_at") WHERE "els_reports"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "els_reports_date_idx" ON "els_reports" USING btree ("business_date","outbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "psp_statement_lines_line_uq" ON "psp_statement_lines" USING btree ("statement_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "psp_statements_file_hash_uq" ON "psp_statements" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX "psp_statements_uploaded_idx" ON "psp_statements" USING btree ("uploaded_at","id");--> statement-breakpoint
CREATE INDEX "reconciliation_mismatches_run_idx" ON "reconciliation_mismatches" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_started_idx" ON "reconciliation_runs" USING btree ("started_at","id");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_statement_idx" ON "reconciliation_runs" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_created_idx" ON "ledger_transactions" USING btree ("created_at");