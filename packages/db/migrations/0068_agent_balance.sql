CREATE TYPE "public"."agent_topup_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."agent_topup_method" AS ENUM('cash', 'bank');--> statement-breakpoint
CREATE TYPE "public"."agent_topup_status" AS ENUM('requested', 'approved', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'agent_balance';--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'house_agent_funding';--> statement-breakpoint
ALTER TYPE "public"."ledger_transaction_type" ADD VALUE 'agent_topup';--> statement-breakpoint
ALTER TYPE "public"."ledger_transaction_type" ADD VALUE 'agent_take_back';--> statement-breakpoint
CREATE TABLE "agent_topups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"direction" "agent_topup_direction" NOT NULL,
	"amount" bigint NOT NULL,
	"method" "agent_topup_method" NOT NULL,
	"bank_reference" text,
	"note" text,
	"status" "agent_topup_status" DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"ledger_transaction_id" uuid,
	CONSTRAINT "agent_topups_amount_positive" CHECK ("agent_topups"."amount" > 0),
	CONSTRAINT "agent_topups_bank_reference" CHECK (("agent_topups"."method" = 'bank') = ("agent_topups"."bank_reference" IS NOT NULL)),
	CONSTRAINT "agent_topups_four_eyes" CHECK ("agent_topups"."decided_by" IS NULL OR "agent_topups"."decided_by" <> "agent_topups"."requested_by"),
	CONSTRAINT "agent_topups_decided" CHECK (("agent_topups"."status" = 'requested') = ("agent_topups"."decided_by" IS NULL AND "agent_topups"."decided_at" IS NULL)),
	CONSTRAINT "agent_topups_posted" CHECK (("agent_topups"."status" = 'approved') = ("agent_topups"."ledger_transaction_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_topups" ADD CONSTRAINT "agent_topups_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_topups" ADD CONSTRAINT "agent_topups_requested_by_admin_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_topups" ADD CONSTRAINT "agent_topups_decided_by_admin_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_topups_agent_idx" ON "agent_topups" USING btree ("agent_id","requested_at");--> statement-breakpoint
CREATE INDEX "agent_topups_requested_idx" ON "agent_topups" USING btree ("requested_at") WHERE "agent_topups"."status" = 'requested';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_topups_bank_reference_uq" ON "agent_topups" USING btree ("bank_reference") WHERE "agent_topups"."method" = 'bank' AND "agent_topups"."status" <> 'rejected';--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_agent_uq" ON "ledger_accounts" USING btree ("agent_id") WHERE "ledger_accounts"."agent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_agent" CHECK (("ledger_accounts"."kind"::text = 'agent_balance') = ("ledger_accounts"."agent_id" IS NOT NULL));--> statement-breakpoint
-- Top-ups and take-backs are records: never deleted by the application.
REVOKE DELETE ON agent_topups FROM vamos_app;
