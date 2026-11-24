CREATE TYPE "public"."shop_device_status" AS ENUM('pending', 'approved', 'revoked');--> statement-breakpoint
CREATE TABLE "shop_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"label" text NOT NULL,
	"secret_hash" text NOT NULL,
	"status" "shop_device_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"decided_by" uuid,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "shop_devices_label_length" CHECK (char_length("shop_devices"."label") BETWEEN 1 AND 60),
	CONSTRAINT "shop_devices_secret_hash_format" CHECK ("shop_devices"."secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "shop_devices_user_agent_length" CHECK (char_length("shop_devices"."user_agent") <= 300),
	CONSTRAINT "shop_devices_revoked_consistent" CHECK (("shop_devices"."status" = 'revoked') = ("shop_devices"."revoked_at" IS NOT NULL)),
	CONSTRAINT "shop_devices_approved_consistent" CHECK ("shop_devices"."status" <> 'approved' OR "shop_devices"."approved_at" IS NOT NULL),
	CONSTRAINT "shop_devices_pending_consistent" CHECK ("shop_devices"."status" <> 'pending' OR "shop_devices"."approved_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "shop_devices" ADD CONSTRAINT "shop_devices_shop_id_cashier_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."cashier_shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_devices" ADD CONSTRAINT "shop_devices_requested_by_admin_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_devices" ADD CONSTRAINT "shop_devices_decided_by_admin_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_devices_secret_uq" ON "shop_devices" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "shop_devices_shop_idx" ON "shop_devices" USING btree ("shop_id","status");--> statement-breakpoint
-- A device is revoked, never deleted: the audit trail and the sessions it carried keep pointing at it.
REVOKE DELETE ON "shop_devices" FROM vamos_app;
