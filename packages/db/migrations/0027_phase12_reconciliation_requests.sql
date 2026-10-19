CREATE TYPE "public"."reconciliation_request_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "reconciliation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "reconciliation_request_status" DEFAULT 'queued' NOT NULL,
	"business_date" date NOT NULL,
	"requested_by" text NOT NULL,
	"ip" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"requested_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"run_id" uuid,
	CONSTRAINT "reconciliation_requests_done" CHECK (("reconciliation_requests"."status" = 'done') = ("reconciliation_requests"."run_id" IS NOT NULL)),
	CONSTRAINT "reconciliation_requests_run_id" CHECK ("reconciliation_requests"."run_id" IS NULL OR "reconciliation_requests"."run_id" = "reconciliation_requests"."id")
);
--> statement-breakpoint
ALTER TABLE "reconciliation_requests" ADD CONSTRAINT "reconciliation_requests_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_requests_requested_idx" ON "reconciliation_requests" USING btree ("requested_at","id");