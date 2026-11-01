ALTER TABLE "scrape_sources" DROP CONSTRAINT "scrape_sources_adapter";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "close_lead_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_close_lead_range" CHECK ("events"."close_lead_ms" BETWEEN 0 AND 21600000);--> statement-breakpoint
ALTER TABLE "scrape_sources" ADD CONSTRAINT "scrape_sources_adapter" CHECK ("scrape_sources"."adapter" IN ('openfootball', 'generic-json', 'generic-html', 'therundown'));