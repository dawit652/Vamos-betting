CREATE TABLE "scrape_close_prices" (
	"event_id" uuid NOT NULL,
	"market" text NOT NULL,
	"line" text DEFAULT '' NOT NULL,
	"selection" text NOT NULL,
	"pricing_source" text NOT NULL,
	"our_odds_milli" integer,
	"consensus_ppm" integer,
	"pinnacle_ppm" integer,
	"best_odds_milli" integer,
	"best_bookmaker" text,
	"books" integer DEFAULT 0 NOT NULL,
	"overround_ppm" integer,
	"captured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scrape_close_prices_event_id_market_line_selection_pk" PRIMARY KEY("event_id","market","line","selection"),
	CONSTRAINT "scrape_close_prices_market" CHECK ("scrape_close_prices"."market" IN ('1x2', 'ou')),
	CONSTRAINT "scrape_close_prices_selection" CHECK ("scrape_close_prices"."selection" IN ('1', 'X', '2', 'over', 'under')),
	CONSTRAINT "scrape_close_prices_pricing_source" CHECK ("scrape_close_prices"."pricing_source" IN ('model', 'market')),
	CONSTRAINT "scrape_close_prices_ppm_range" CHECK (("scrape_close_prices"."consensus_ppm" IS NULL OR "scrape_close_prices"."consensus_ppm" BETWEEN 0 AND 1000000) AND ("scrape_close_prices"."pinnacle_ppm" IS NULL OR "scrape_close_prices"."pinnacle_ppm" BETWEEN 0 AND 1000000))
);
--> statement-breakpoint
ALTER TABLE "scrape_close_prices" ADD CONSTRAINT "scrape_close_prices_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scrape_close_prices_captured_idx" ON "scrape_close_prices" USING btree ("captured_at");