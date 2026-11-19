ALTER TABLE "admin_sessions" ADD COLUMN "channel" text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_channel" CHECK ("admin_sessions"."channel" IN ('admin', 'shop'));--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_shop_device" CHECK (("admin_sessions"."channel" = 'shop') = ("admin_sessions"."device_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_device_id_shop_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."shop_devices"("id") ON DELETE no action ON UPDATE no action;
