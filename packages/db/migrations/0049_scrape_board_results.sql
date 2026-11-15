CREATE TABLE "scrape_board_results" (
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
ALTER TABLE "scrape_board_results" ADD CONSTRAINT "scrape_board_results_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;