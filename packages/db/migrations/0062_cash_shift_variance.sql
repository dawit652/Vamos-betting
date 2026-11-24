ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'house_cash_variance';--> statement-breakpoint
CREATE TABLE "cash_shift_variance_postings" (
	"shift_id" uuid PRIMARY KEY NOT NULL,
	"amount" bigint NOT NULL,
	"ledger_transaction_id" uuid NOT NULL,
	"posted_by" uuid NOT NULL,
	"posted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_shift_variance_postings" ADD CONSTRAINT "cash_shift_variance_postings_shift_id_cashier_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cashier_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_shift_variance_postings" ADD CONSTRAINT "cash_shift_variance_postings_posted_by_admin_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;