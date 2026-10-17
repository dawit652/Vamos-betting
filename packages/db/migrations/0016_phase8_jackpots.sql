CREATE TYPE "public"."jackpot_entry_status" AS ENUM('open', 'won', 'lost', 'void');--> statement-breakpoint
CREATE TYPE "public"."jackpot_round_status" AS ENUM('scheduled', 'open', 'closed', 'settled', 'cancelled');--> statement-breakpoint
CREATE TABLE "jackpot_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"picks" jsonb NOT NULL,
	"combinations" integer NOT NULL,
	"cost" bigint NOT NULL,
	"channel" "bet_channel" DEFAULT 'web' NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "jackpot_entry_status" DEFAULT 'open' NOT NULL,
	"correct" jsonb,
	"best_correct" integer,
	"prize_gross" bigint,
	"prize_tax" bigint,
	"prize_net" bigint,
	"placed_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jackpot_entries_cost_positive" CHECK ("jackpot_entries"."cost" > 0),
	CONSTRAINT "jackpot_entries_combinations" CHECK ("jackpot_entries"."combinations" >= 1),
	CONSTRAINT "jackpot_entries_settled_at" CHECK (("jackpot_entries"."status" = 'open') = ("jackpot_entries"."settled_at" IS NULL)),
	CONSTRAINT "jackpot_entries_prize" CHECK (("jackpot_entries"."status" = 'open' AND "jackpot_entries"."prize_gross" IS NULL AND "jackpot_entries"."prize_tax" IS NULL AND "jackpot_entries"."prize_net" IS NULL) OR ("jackpot_entries"."status" <> 'open' AND "jackpot_entries"."prize_tax" >= 0 AND "jackpot_entries"."prize_net" >= 0 AND "jackpot_entries"."prize_gross" = "jackpot_entries"."prize_net" + "jackpot_entries"."prize_tax")),
	CONSTRAINT "jackpot_entries_prize_status" CHECK (("jackpot_entries"."status" <> 'won' OR "jackpot_entries"."prize_gross" > 0) AND ("jackpot_entries"."status" NOT IN ('lost', 'void') OR "jackpot_entries"."prize_gross" = 0)),
	CONSTRAINT "jackpot_entries_correct" CHECK (("jackpot_entries"."status" IN ('won', 'lost')) = ("jackpot_entries"."correct" IS NOT NULL AND "jackpot_entries"."best_correct" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "jackpot_games" (
	"round_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"event_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"home_selection_id" uuid NOT NULL,
	"draw_selection_id" uuid NOT NULL,
	"away_selection_id" uuid NOT NULL,
	"result" text,
	"resulted_at" timestamp with time zone,
	CONSTRAINT "jackpot_games_pk" PRIMARY KEY("round_id","position"),
	CONSTRAINT "jackpot_games_position" CHECK ("jackpot_games"."position" >= 0),
	CONSTRAINT "jackpot_games_result" CHECK ("jackpot_games"."result" IS NULL OR "jackpot_games"."result" IN ('1', 'X', '2', 'cancelled')),
	CONSTRAINT "jackpot_games_resulted_at" CHECK (("jackpot_games"."result" IS NULL) = ("jackpot_games"."resulted_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "jackpot_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_code" text NOT NULL,
	"status" "jackpot_round_status" NOT NULL,
	"game_count" integer NOT NULL,
	"cost_per_combination" bigint NOT NULL,
	"max_combinations" integer NOT NULL,
	"pool" bigint NOT NULL,
	"terms" jsonb NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"settlement" jsonb,
	"results_flagged_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jackpot_rounds_template_code" CHECK ("jackpot_rounds"."template_code" ~ '^[a-z][a-z0-9_]{0,31}$'),
	CONSTRAINT "jackpot_rounds_game_count" CHECK ("jackpot_rounds"."game_count" BETWEEN 1 AND 30),
	CONSTRAINT "jackpot_rounds_cost_positive" CHECK ("jackpot_rounds"."cost_per_combination" > 0),
	CONSTRAINT "jackpot_rounds_max_combinations" CHECK ("jackpot_rounds"."max_combinations" >= 1),
	CONSTRAINT "jackpot_rounds_pool_non_negative" CHECK ("jackpot_rounds"."pool" >= 0),
	CONSTRAINT "jackpot_rounds_closed_at" CHECK (("jackpot_rounds"."status" IN ('scheduled', 'open')) = ("jackpot_rounds"."closed_at" IS NULL)),
	CONSTRAINT "jackpot_rounds_final" CHECK (("jackpot_rounds"."status" IN ('settled', 'cancelled')) = ("jackpot_rounds"."settled_at" IS NOT NULL AND "jackpot_rounds"."settlement" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "jackpot_entries" ADD CONSTRAINT "jackpot_entries_round_id_jackpot_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."jackpot_rounds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jackpot_entries" ADD CONSTRAINT "jackpot_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jackpot_games" ADD CONSTRAINT "jackpot_games_round_id_jackpot_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."jackpot_rounds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jackpot_games" ADD CONSTRAINT "jackpot_games_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jackpot_entries_user_idempotency_uq" ON "jackpot_entries" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "jackpot_entries_user_placed_idx" ON "jackpot_entries" USING btree ("user_id","placed_at","id");--> statement-breakpoint
CREATE INDEX "jackpot_entries_round_status_idx" ON "jackpot_entries" USING btree ("round_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "jackpot_games_round_event_uq" ON "jackpot_games" USING btree ("round_id","event_id");--> statement-breakpoint
CREATE INDEX "jackpot_games_event_idx" ON "jackpot_games" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "jackpot_games_market_idx" ON "jackpot_games" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "jackpot_rounds_status_closes_idx" ON "jackpot_rounds" USING btree ("status","closes_at");--> statement-breakpoint
CREATE INDEX "jackpot_rounds_template_status_idx" ON "jackpot_rounds" USING btree ("template_code","status","closes_at");