CREATE TYPE "public"."retail_alert_kind" AS ENUM('big_win', 'repeated_picks', 'many_cancels', 'late_ticket', 'low_balance', 'payout_waiting', 'device_waiting');--> statement-breakpoint
CREATE TABLE "retail_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "retail_alert_kind" NOT NULL,
	"dedup_key" text NOT NULL,
	"agent_id" uuid,
	"shop_id" uuid,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid
);
--> statement-breakpoint
ALTER TABLE "retail_alerts" ADD CONSTRAINT "retail_alerts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_alerts" ADD CONSTRAINT "retail_alerts_shop_id_cashier_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."cashier_shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_alerts" ADD CONSTRAINT "retail_alerts_acknowledged_by_admin_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_alerts_dedup_uq" ON "retail_alerts" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "retail_alerts_open_idx" ON "retail_alerts" USING btree ("created_at") WHERE "retail_alerts"."acknowledged_at" IS NULL;--> statement-breakpoint
ALTER TABLE "retail_alerts" ADD CONSTRAINT "retail_alerts_acknowledged" CHECK (("acknowledged_at" IS NULL) = ("acknowledged_by" IS NULL));
--> statement-breakpoint
-- Alerts are acknowledged, never deleted.
REVOKE DELETE, TRUNCATE ON "retail_alerts" FROM vamos_app;
