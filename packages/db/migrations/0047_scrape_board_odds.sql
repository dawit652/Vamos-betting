CREATE TABLE "scrape_board_odds" (
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
ALTER TABLE "scrape_board_odds" ADD CONSTRAINT "scrape_board_odds_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_board_odds" ADD CONSTRAINT "scrape_board_odds_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_board_odds" ADD CONSTRAINT "scrape_board_odds_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scrape_board_odds_event_idx" ON "scrape_board_odds" USING btree ("event_id","prices_at");--> statement-breakpoint
CREATE INDEX "scrape_board_odds_observed_idx" ON "scrape_board_odds" USING btree ("observed_at");