CREATE TABLE "reference_book_prices" (
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"market_key" text NOT NULL,
	"outcome" text NOT NULL,
	"book_id" integer NOT NULL,
	"american" integer NOT NULL,
	"odds_milli" integer NOT NULL,
	"vendor_updated_at" timestamp with time zone NOT NULL,
	"liquidity_usd" double precision,
	"fetched_at" timestamp with time zone NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	CONSTRAINT "reference_book_prices_pk" PRIMARY KEY("provider","provider_event_id","market_key","outcome","book_id"),
	CONSTRAINT "reference_book_prices_provider" CHECK ("reference_book_prices"."provider" IN ('therundown')),
	CONSTRAINT "reference_book_prices_odds" CHECK ("reference_book_prices"."odds_milli" BETWEEN 1001 AND 1000000),
	CONSTRAINT "reference_book_prices_american" CHECK (abs("reference_book_prices"."american") >= 100)
);
--> statement-breakpoint
CREATE TABLE "reference_budget" (
	"provider" text PRIMARY KEY NOT NULL,
	"used" bigint,
	"remaining" bigint,
	"reset_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"spent_day" date NOT NULL,
	"spent_today" bigint DEFAULT 0 NOT NULL,
	"delay_seconds" integer,
	"rate_limit" integer,
	"level" text DEFAULT 'unknown' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_budget_provider" CHECK ("reference_budget"."provider" IN ('therundown')),
	CONSTRAINT "reference_budget_level" CHECK ("reference_budget"."level" IN ('unknown', 'green', 'amber', 'red')),
	CONSTRAINT "reference_budget_spent" CHECK ("reference_budget"."spent_today" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reference_consensus" (
	"event_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"market_key" text NOT NULL,
	"fair" jsonb NOT NULL,
	"books_used" jsonb NOT NULL,
	"dispersion" double precision NOT NULL,
	"confidence" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reference_consensus_pk" PRIMARY KEY("event_id","provider","market_key"),
	CONSTRAINT "reference_consensus_provider" CHECK ("reference_consensus"."provider" IN ('therundown')),
	CONSTRAINT "reference_consensus_confidence" CHECK ("reference_consensus"."confidence" IN ('high', 'normal', 'low')),
	CONSTRAINT "reference_consensus_dispersion" CHECK ("reference_consensus"."dispersion" >= 0 AND "reference_consensus"."dispersion" <= 1)
);
--> statement-breakpoint
CREATE TABLE "reference_event_map" (
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"provider_sport_id" integer NOT NULL,
	"home_team_ref" integer NOT NULL,
	"away_team_ref" integer NOT NULL,
	"kickoff" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reference_event_map_pk" PRIMARY KEY("provider","provider_event_id"),
	CONSTRAINT "reference_event_map_provider" CHECK ("reference_event_map"."provider" IN ('therundown'))
);
--> statement-breakpoint
CREATE TABLE "reference_poll_state" (
	"provider" text NOT NULL,
	"request_key" text NOT NULL,
	"last_fetched_at" timestamp with time zone NOT NULL,
	"last_outcome" text NOT NULL,
	"last_cost" integer,
	"details" jsonb,
	CONSTRAINT "reference_poll_state_pk" PRIMARY KEY("provider","request_key"),
	CONSTRAINT "reference_poll_state_provider" CHECK ("reference_poll_state"."provider" IN ('therundown'))
);
--> statement-breakpoint
ALTER TABLE "reference_consensus" ADD CONSTRAINT "reference_consensus_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_event_map" ADD CONSTRAINT "reference_event_map_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reference_book_prices_fetched_idx" ON "reference_book_prices" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "reference_consensus_computed_idx" ON "reference_consensus" USING btree ("computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reference_event_map_event_uq" ON "reference_event_map" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "reference_event_map_seen_idx" ON "reference_event_map" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "reference_poll_state_fetched_idx" ON "reference_poll_state" USING btree ("last_fetched_at");