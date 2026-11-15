CREATE TABLE "scrape_ladder_shadow" (
	"event_id" uuid NOT NULL,
	"decision_key" text NOT NULL,
	"rung" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"score" jsonb,
	"strict" boolean,
	"upstreams" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dissent" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_decided_at" timestamp with time zone NOT NULL,
	"last_decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scrape_ladder_shadow_event_id_decision_key_pk" PRIMARY KEY("event_id","decision_key"),
	CONSTRAINT "scrape_ladder_shadow_rung" CHECK ("scrape_ladder_shadow"."rung" IN ('B', 'C', 'D')),
	CONSTRAINT "scrape_ladder_shadow_action" CHECK (("scrape_ladder_shadow"."action" = 'apply' AND "scrape_ladder_shadow"."rung" IN ('B', 'C') AND "scrape_ladder_shadow"."score" IS NOT NULL) OR ("scrape_ladder_shadow"."action" = 'void' AND "scrape_ladder_shadow"."rung" = 'D' AND "scrape_ladder_shadow"."strict" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "scrape_source_trust" (
	"upstream" text NOT NULL,
	"sport" text NOT NULL,
	"compared" integer NOT NULL,
	"agreed" integer NOT NULL,
	"window_from" timestamp with time zone,
	"window_to" timestamp with time zone,
	"disagreements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scrape_source_trust_upstream_sport_pk" PRIMARY KEY("upstream","sport"),
	CONSTRAINT "scrape_source_trust_sport" CHECK ("scrape_source_trust"."sport" IN ('football')),
	CONSTRAINT "scrape_source_trust_upstream" CHECK (btrim("scrape_source_trust"."upstream") <> ''),
	CONSTRAINT "scrape_source_trust_counts" CHECK ("scrape_source_trust"."compared" >= 0 AND "scrape_source_trust"."agreed" BETWEEN 0 AND "scrape_source_trust"."compared")
);
--> statement-breakpoint
ALTER TABLE "scrape_ladder_shadow" ADD CONSTRAINT "scrape_ladder_shadow_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scrape_ladder_shadow_first_idx" ON "scrape_ladder_shadow" USING btree ("first_decided_at");