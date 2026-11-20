CREATE TABLE "cash_pin_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"shop_id" uuid,
	"requested_by" uuid NOT NULL,
	"status" text NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cash_pin_resets_status" CHECK ("cash_pin_resets"."status" IN ('requested', 'approved', 'issued', 'rejected', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "cash_pin_resets" ADD CONSTRAINT "cash_pin_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_pin_resets" ADD CONSTRAINT "cash_pin_resets_shop_id_cashier_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."cashier_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_pin_resets" ADD CONSTRAINT "cash_pin_resets_requested_by_admin_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_pin_resets" ADD CONSTRAINT "cash_pin_resets_approved_by_admin_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_pin_resets_open_uq" ON "cash_pin_resets" USING btree ("user_id") WHERE "cash_pin_resets"."status" IN ('requested', 'approved');--> statement-breakpoint
CREATE INDEX "cash_pin_resets_status_idx" ON "cash_pin_resets" USING btree ("status","created_at");