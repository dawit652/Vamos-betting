CREATE TYPE "public"."agent_commission_kind" AS ENUM('stake', 'ggr');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('active', 'blocked');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"owner_name" text NOT NULL,
	"owner_phone" text NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"commission_kind" "agent_commission_kind" DEFAULT 'ggr' NOT NULL,
	"commission_bps" integer DEFAULT 0 NOT NULL,
	"player_cash_enabled" boolean DEFAULT false NOT NULL,
	"is_house" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_number_range" CHECK ("agents"."number" BETWEEN 1000 AND 999999),
	CONSTRAINT "agents_house_number" CHECK (("agents"."number" = 1000) = "agents"."is_house"),
	CONSTRAINT "agents_name_length" CHECK (char_length("agents"."name") BETWEEN 2 AND 100),
	CONSTRAINT "agents_owner_name_length" CHECK (char_length("agents"."owner_name") BETWEEN 2 AND 100),
	CONSTRAINT "agents_owner_phone_format" CHECK ("agents"."is_house" OR "agents"."owner_phone" ~ '^\+251[79][0-9]{8}$'),
	CONSTRAINT "agents_commission_bps_range" CHECK ("agents"."commission_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "agents_blocked_consistent" CHECK (("agents"."status" = 'blocked') = ("agents"."blocked_at" IS NOT NULL)),
	CONSTRAINT "agents_house_not_blocked" CHECK (NOT ("agents"."is_house" AND "agents"."status" = 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "cashier_shops" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "cashier_shops" ADD COLUMN "number" integer;--> statement-breakpoint
-- Agent 1000 is Nahubet HQ (the house); every shop that exists today is an HQ shop, numbered in the
-- order it was created (docs/plans/agent-shops.md).
INSERT INTO "agents" ("number", "name", "owner_name", "owner_phone", "is_house") VALUES (1000, 'Nahubet HQ', 'Nahubet', '', true);--> statement-breakpoint
UPDATE "cashier_shops" AS s SET "agent_id" = (SELECT "id" FROM "agents" WHERE "is_house"), "number" = n.rn FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "code") AS rn FROM "cashier_shops") AS n WHERE n."id" = s."id";--> statement-breakpoint
ALTER TABLE "cashier_shops" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cashier_shops" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_number_uq" ON "agents" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_house_uq" ON "agents" USING btree ("is_house") WHERE "agents"."is_house";--> statement-breakpoint
ALTER TABLE "cashier_shops" ADD CONSTRAINT "cashier_shops_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cashier_shops_agent_number_uq" ON "cashier_shops" USING btree ("agent_id","number");--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_phone_format" CHECK ("admin_users"."phone" IS NULL OR "admin_users"."phone" ~ '^\+251[79][0-9]{8}$');--> statement-breakpoint
ALTER TABLE "cashier_shops" ADD CONSTRAINT "cashier_shops_number_range" CHECK ("cashier_shops"."number" BETWEEN 1 AND 999);--> statement-breakpoint
-- An agent is never deleted (its shops, tickets and ledger keep pointing at it): blocking stops it.
REVOKE DELETE ON "agents" FROM vamos_app;
