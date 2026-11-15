CREATE TABLE "market_family_moves" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"week" text NOT NULL,
	"family" text NOT NULL,
	"move" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"margin_bps" integer,
	"raised_margin_bps" integer,
	"reason" text NOT NULL,
	"weeks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_family_moves_move" CHECK ("market_family_moves"."move" IN ('suspend', 'return', 'off'))
);
--> statement-breakpoint
CREATE TABLE "market_family_state" (
	"family" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"since_week" text,
	"raised_margin_bps" integer,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_family_state_status" CHECK ("market_family_state"."status" IN ('active', 'suspended', 'off')),
	CONSTRAINT "market_family_state_raised" CHECK ("market_family_state"."raised_margin_bps" IS NULL OR "market_family_state"."raised_margin_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "market_family_state_moved" CHECK ("market_family_state"."status" = 'active' OR ("market_family_state"."raised_margin_bps" IS NOT NULL AND "market_family_state"."since_week" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "market_family_moves_week_family_uq" ON "market_family_moves" USING btree ("week","family");--> statement-breakpoint
CREATE INDEX "market_family_moves_family_idx" ON "market_family_moves" USING btree ("family","created_at");--> statement-breakpoint
-- Append-only: a move of the weekly family job is never edited or deleted (like 0034).
REVOKE UPDATE, DELETE ON market_family_moves FROM vamos_app;
