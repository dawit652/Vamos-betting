ALTER TYPE "public"."ledger_transaction_type" ADD VALUE 'retail_ticket_payout';--> statement-breakpoint
ALTER TYPE "public"."ledger_transaction_type" ADD VALUE 'retail_ticket_expiry';--> statement-breakpoint
ALTER TYPE "public"."retail_ticket_status" ADD VALUE 'paid';--> statement-breakpoint
ALTER TYPE "public"."retail_ticket_status" ADD VALUE 'expired';--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "paid_by" uuid;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "paid_shift_id" uuid;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "paid_amount" bigint;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "payout_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "payout_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "approval_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "approval_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_paid_by_admin_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_paid_shift_id_cashier_shifts_id_fk" FOREIGN KEY ("paid_shift_id") REFERENCES "public"."cashier_shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_approval_requested_by_admin_users_id_fk" FOREIGN KEY ("approval_requested_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_approved_by_admin_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_tickets_payout_key_uq" ON "retail_tickets" USING btree ("payout_idempotency_key") WHERE "retail_tickets"."payout_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "retail_tickets_approval_idx" ON "retail_tickets" USING btree ("approval_requested_at") WHERE "retail_tickets"."approval_requested_at" IS NOT NULL AND "retail_tickets"."approved_at" IS NULL;--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_paid" CHECK (("retail_tickets"."status"::text = 'paid') = ("retail_tickets"."paid_at" IS NOT NULL AND "retail_tickets"."paid_by" IS NOT NULL AND "retail_tickets"."paid_shift_id" IS NOT NULL AND "retail_tickets"."paid_amount" IS NOT NULL AND "retail_tickets"."payout_transaction_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_paid_amount" CHECK ("retail_tickets"."paid_amount" IS NULL OR "retail_tickets"."paid_amount" > 0);--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_expired" CHECK (("retail_tickets"."status"::text = 'expired') = ("retail_tickets"."expired_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "retail_tickets" ADD CONSTRAINT "retail_tickets_approval_four_eyes" CHECK ("retail_tickets"."approved_by" IS NULL OR "retail_tickets"."approval_requested_by" IS NULL OR "retail_tickets"."approved_by" <> "retail_tickets"."approval_requested_by");