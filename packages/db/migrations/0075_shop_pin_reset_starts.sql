CREATE TABLE "cash_pin_reset_tries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"shop_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cash_pin_reset_tries_reason" CHECK ("cash_pin_reset_tries"."reason" IN ('desk_code', 'no_verified_id', 'id_number'))
);
--> statement-breakpoint
CREATE TABLE "pin_reset_starts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"secret_hash" text NOT NULL,
	"desk_code" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"requester_key" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "pin_reset_starts_status" CHECK ("pin_reset_starts"."status" IN ('waiting', 'linked', 'done', 'closed')),
	CONSTRAINT "pin_reset_starts_done" CHECK (("pin_reset_starts"."status" = 'done') = ("pin_reset_starts"."completed_at" IS NOT NULL)),
	CONSTRAINT "pin_reset_starts_desk_code" CHECK ("pin_reset_starts"."desk_code" ~ '^[0-9]{8}$')
);
--> statement-breakpoint
ALTER TABLE "cash_pin_resets" ADD COLUMN "start_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_pin_reset_tries" ADD CONSTRAINT "cash_pin_reset_tries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_pin_reset_tries" ADD CONSTRAINT "cash_pin_reset_tries_staff_id_admin_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_pin_reset_tries" ADD CONSTRAINT "cash_pin_reset_tries_shop_id_cashier_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."cashier_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_pin_reset_tries_user_idx" ON "cash_pin_reset_tries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pin_reset_starts_secret_uq" ON "pin_reset_starts" USING btree ("secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "pin_reset_starts_desk_code_uq" ON "pin_reset_starts" USING btree ("desk_code") WHERE "pin_reset_starts"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "pin_reset_starts_phone_idx" ON "pin_reset_starts" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "pin_reset_starts_requester_idx" ON "pin_reset_starts" USING btree ("requester_key","created_at");--> statement-breakpoint
ALTER TABLE "cash_pin_resets" ADD CONSTRAINT "cash_pin_resets_start_id_pin_reset_starts_id_fk" FOREIGN KEY ("start_id") REFERENCES "public"."pin_reset_starts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_pin_resets_start_uq" ON "cash_pin_resets" USING btree ("start_id") WHERE "cash_pin_resets"."start_id" IS NOT NULL;