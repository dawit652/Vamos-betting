CREATE TABLE "scrape_event_pricing" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"ratings_key" text,
	"priced_at" timestamp with time zone,
	"held_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scrape_event_pricing" ADD CONSTRAINT "scrape_event_pricing_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;