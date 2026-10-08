ALTER TABLE "events" ADD COLUMN "sim_seed" text;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "suspended_by" text;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_game_id_range" CHECK ("events"."game_id" BETWEEN 100 AND 999999);--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_suspended_by_valid" CHECK ("markets"."suspended_by" IS NULL OR ("markets"."suspended_by" IN ('feed', 'trader') AND "markets"."status" = 'suspended'));