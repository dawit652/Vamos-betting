CREATE TABLE "scrape_market_odds" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"raw_id" uuid,
	"source_key" text NOT NULL,
	"sport" text NOT NULL,
	"competition_raw" text NOT NULL,
	"home_raw" text NOT NULL,
	"away_raw" text NOT NULL,
	"kickoff" timestamp with time zone NOT NULL,
	"competition_id" uuid,
	"home_team_id" uuid,
	"away_team_id" uuid,
	"event_id" uuid,
	"market" text NOT NULL,
	"line" text,
	"line_key" text GENERATED ALWAYS AS (coalesce(line, '')) STORED,
	"selection" text NOT NULL,
	"bookmaker" text NOT NULL,
	"price_milli" integer NOT NULL,
	"price_updated_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scrape_market_odds_sport" CHECK ("scrape_market_odds"."sport" IN ('football')),
	CONSTRAINT "scrape_market_odds_market" CHECK ("scrape_market_odds"."market" IN ('1x2', 'ou')),
	CONSTRAINT "scrape_market_odds_selection" CHECK ("scrape_market_odds"."selection" IN ('1', 'X', '2', 'over', 'under')),
	CONSTRAINT "scrape_market_odds_market_selection" CHECK (("scrape_market_odds"."market" = '1x2' AND "scrape_market_odds"."selection" IN ('1', 'X', '2') AND "scrape_market_odds"."line" IS NULL) OR ("scrape_market_odds"."market" = 'ou' AND "scrape_market_odds"."selection" IN ('over', 'under') AND "scrape_market_odds"."line" IS NOT NULL AND "scrape_market_odds"."line" ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$')),
	CONSTRAINT "scrape_market_odds_price" CHECK ("scrape_market_odds"."price_milli" BETWEEN 1010 AND 1000000),
	CONSTRAINT "scrape_market_odds_teams_differ" CHECK ("scrape_market_odds"."home_team_id" IS NULL OR "scrape_market_odds"."away_team_id" IS NULL OR "scrape_market_odds"."home_team_id" <> "scrape_market_odds"."away_team_id")
);
--> statement-breakpoint
ALTER TABLE "scrape_sources" DROP CONSTRAINT "scrape_sources_adapter";--> statement-breakpoint
ALTER TABLE "scrape_market_odds" ADD CONSTRAINT "scrape_market_odds_source_id_scrape_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."scrape_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_market_odds" ADD CONSTRAINT "scrape_market_odds_run_id_scrape_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scrape_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_market_odds" ADD CONSTRAINT "scrape_market_odds_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_market_odds" ADD CONSTRAINT "scrape_market_odds_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_market_odds" ADD CONSTRAINT "scrape_market_odds_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_market_odds" ADD CONSTRAINT "scrape_market_odds_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scrape_market_odds_key_uq" ON "scrape_market_odds" USING btree ("source_id","source_key","bookmaker","market","line_key","selection");--> statement-breakpoint
CREATE INDEX "scrape_market_odds_event_idx" ON "scrape_market_odds" USING btree ("event_id","market","line","observed_at");--> statement-breakpoint
CREATE INDEX "scrape_market_odds_observed_idx" ON "scrape_market_odds" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "scrape_market_odds_unlinked_idx" ON "scrape_market_odds" USING btree ("observed_at") WHERE "scrape_market_odds"."event_id" IS NULL;--> statement-breakpoint
CREATE INDEX "scrape_market_odds_raw_idx" ON "scrape_market_odds" USING btree ("source_id","raw_id");--> statement-breakpoint
ALTER TABLE "scrape_sources" ADD CONSTRAINT "scrape_sources_adapter" CHECK ("scrape_sources"."adapter" IN ('openfootball', 'generic-json', 'generic-html', 'therundown'));