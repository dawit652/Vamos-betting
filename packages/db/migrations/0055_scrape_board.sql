-- The Hulusport board's four tables. SAFE TO RUN WHERE THEY ALREADY EXIST, on purpose: the live
-- server created them with three migrations of its own (numbered 0047 to 0049 there, not in this
-- repository), and this one migration replaces those three. Every statement is skipped when its
-- table, index or constraint is already there; on a fresh database it creates them all.
CREATE TABLE IF NOT EXISTS "scrape_board_competitions" (
	"board" text NOT NULL,
	"league_key" text NOT NULL,
	"competition_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scrape_board_competitions_board_league_key_pk" PRIMARY KEY("board","league_key"),
	CONSTRAINT "scrape_board_competitions_board" CHECK ("scrape_board_competitions"."board" IN ('hulusport'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scrape_board_odds" (
	"source_key" text PRIMARY KEY NOT NULL,
	"board" text NOT NULL,
	"competition_raw" text NOT NULL,
	"home_raw" text NOT NULL,
	"away_raw" text NOT NULL,
	"kickoff" timestamp with time zone NOT NULL,
	"home_team_id" uuid,
	"away_team_id" uuid,
	"event_id" uuid,
	"markets" jsonb NOT NULL,
	"prices_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scrape_board_odds_board" CHECK ("scrape_board_odds"."board" IN ('hulusport')),
	CONSTRAINT "scrape_board_odds_teams_differ" CHECK ("scrape_board_odds"."home_team_id" IS NULL OR "scrape_board_odds"."away_team_id" IS NULL OR "scrape_board_odds"."home_team_id" <> "scrape_board_odds"."away_team_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scrape_board_results" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"fixture_id" integer NOT NULL,
	"status" text NOT NULL,
	"home" integer NOT NULL,
	"away" integer NOT NULL,
	"ht_home" integer,
	"ht_away" integer,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "scrape_board_results_scores" CHECK ("scrape_board_results"."home" BETWEEN 0 AND 99 AND "scrape_board_results"."away" BETWEEN 0 AND 99 AND ("scrape_board_results"."ht_home" IS NULL OR "scrape_board_results"."ht_home" BETWEEN 0 AND "scrape_board_results"."home") AND ("scrape_board_results"."ht_away" IS NULL OR "scrape_board_results"."ht_away" BETWEEN 0 AND "scrape_board_results"."away"))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scrape_board_teams" (
	"board" text NOT NULL,
	"raw_name" text NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scrape_board_teams_board_raw_name_pk" PRIMARY KEY("board","raw_name"),
	CONSTRAINT "scrape_board_teams_board" CHECK ("scrape_board_teams"."board" IN ('hulusport'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scrape_board_competitions" ADD CONSTRAINT "scrape_board_competitions_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scrape_board_odds" ADD CONSTRAINT "scrape_board_odds_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scrape_board_odds" ADD CONSTRAINT "scrape_board_odds_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scrape_board_odds" ADD CONSTRAINT "scrape_board_odds_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scrape_board_results" ADD CONSTRAINT "scrape_board_results_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scrape_board_teams" ADD CONSTRAINT "scrape_board_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scrape_board_competitions_competition_uq" ON "scrape_board_competitions" USING btree ("competition_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scrape_board_odds_event_idx" ON "scrape_board_odds" USING btree ("event_id","prices_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scrape_board_odds_observed_idx" ON "scrape_board_odds" USING btree ("observed_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scrape_board_teams_team_uq" ON "scrape_board_teams" USING btree ("team_id");
