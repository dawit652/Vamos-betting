CREATE TYPE "public"."event_status" AS ENUM('scheduled', 'live', 'finished', 'cancelled', 'postponed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."market_status" AS ENUM('open', 'suspended', 'closed', 'settled', 'void');--> statement-breakpoint
CREATE TYPE "public"."selection_result" AS ENUM('won', 'lost', 'void');--> statement-breakpoint
CREATE TYPE "public"."selection_status" AS ENUM('open', 'suspended', 'settled');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sport_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" jsonb NOT NULL,
	"country_code" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sport_id" text NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" jsonb NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" integer NOT NULL,
	"sport_id" text NOT NULL,
	"competition_id" uuid NOT NULL,
	"home_team_id" uuid NOT NULL,
	"away_team_id" uuid NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"status" "event_status" DEFAULT 'scheduled' NOT NULL,
	"betting_open" boolean DEFAULT true NOT NULL,
	"live_minute" integer,
	"period" text,
	"score_home" integer,
	"score_away" integer,
	"ht_score_home" integer,
	"ht_score_away" integer,
	"feed_provider" text NOT NULL,
	"feed_ref" text NOT NULL,
	"resulted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_game_id_unique" UNIQUE("game_id")
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"line" text,
	"key" text NOT NULL,
	"status" "market_status" DEFAULT 'open' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "odds_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"selection_id" uuid NOT NULL,
	"odds_milli" integer NOT NULL,
	"source" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"code" text NOT NULL,
	"odds_milli" integer NOT NULL,
	"status" "selection_status" DEFAULT 'open' NOT NULL,
	"result" "selection_result",
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "selections_odds_range" CHECK ("selections"."odds_milli" BETWEEN 1001 AND 1000000)
);
--> statement-breakpoint
CREATE TABLE "sports" (
	"id" text PRIMARY KEY NOT NULL,
	"name" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sport_id" text NOT NULL,
	"name" jsonb NOT NULL,
	"short_name" text NOT NULL,
	"country_code" text,
	"ratings" jsonb
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odds_history" ADD CONSTRAINT "odds_history_selection_id_selections_id_fk" FOREIGN KEY ("selection_id") REFERENCES "public"."selections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selections" ADD CONSTRAINT "selections_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_sport_slug_uq" ON "categories" USING btree ("sport_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "competitions_sport_slug_uq" ON "competitions" USING btree ("sport_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "events_feed_ref_uq" ON "events" USING btree ("feed_provider","feed_ref");--> statement-breakpoint
CREATE INDEX "events_status_start_idx" ON "events" USING btree ("status","start_time");--> statement-breakpoint
CREATE INDEX "events_competition_start_idx" ON "events" USING btree ("competition_id","start_time");--> statement-breakpoint
CREATE INDEX "events_sport_start_idx" ON "events" USING btree ("sport_id","start_time");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_event_key_uq" ON "markets" USING btree ("event_id","key");--> statement-breakpoint
CREATE INDEX "odds_history_selection_idx" ON "odds_history" USING btree ("selection_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "selections_market_code_uq" ON "selections" USING btree ("market_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_sport_short_name_uq" ON "teams" USING btree ("sport_id","short_name");