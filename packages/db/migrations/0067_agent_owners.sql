ALTER TYPE "public"."admin_role" ADD VALUE 'agent_owner';--> statement-breakpoint
ALTER TABLE "admin_sessions" DROP CONSTRAINT "admin_sessions_shop_device";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "owner_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_staff_id_admin_users_id_fk" FOREIGN KEY ("owner_staff_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_owner_staff_uq" ON "agents" USING btree ("owner_staff_id") WHERE "agents"."owner_staff_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_shop_device" CHECK ("admin_sessions"."channel" = 'shop' OR "admin_sessions"."device_id" IS NULL);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_house_no_owner" CHECK (NOT ("agents"."is_house" AND "agents"."owner_staff_id" IS NOT NULL));