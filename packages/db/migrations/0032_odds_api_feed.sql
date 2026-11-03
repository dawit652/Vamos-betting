CREATE TABLE "feed_api_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"sport_key" text,
	"status" integer,
	"cost" integer DEFAULT 0 NOT NULL,
	"remaining" integer,
	"used" integer,
	"error_kind" text,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_api_calls_cost_valid" CHECK ("feed_api_calls"."cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "feed_leagues" (
	"provider" text NOT NULL,
	"sport_key" text NOT NULL,
	"sport_id" text NOT NULL,
	"competition_id" uuid,
	"sport_group" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"active" boolean NOT NULL,
	"enabled" boolean NOT NULL,
	"cup" boolean DEFAULT false NOT NULL,
	"tier" integer NOT NULL,
	"margin_bps" integer,
	"next_start_at" timestamp with time zone,
	"event_count" integer DEFAULT 0 NOT NULL,
	"live_count" integer DEFAULT 0 NOT NULL,
	"last_events_at" timestamp with time zone,
	"last_odds_at" timestamp with time zone,
	"last_scores_at" timestamp with time zone,
	"next_odds_at" timestamp with time zone,
	"next_scores_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_leagues_provider_sport_key_pk" PRIMARY KEY("provider","sport_key"),
	CONSTRAINT "feed_leagues_tier_valid" CHECK ("feed_leagues"."tier" BETWEEN 1 AND 3),
	CONSTRAINT "feed_leagues_margin_valid" CHECK ("feed_leagues"."margin_bps" IS NULL OR "feed_leagues"."margin_bps" BETWEEN 0 AND 3000),
	CONSTRAINT "feed_leagues_counts_valid" CHECK ("feed_leagues"."event_count" >= 0 AND "feed_leagues"."live_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "feed_results" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"score_home" integer,
	"score_away" integer,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"review_reason" text,
	"applied_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_results_scores_valid" CHECK (("feed_results"."score_home" IS NULL) = ("feed_results"."score_away" IS NULL) AND ("feed_results"."score_home" IS NULL OR ("feed_results"."score_home" >= 0 AND "feed_results"."score_away" >= 0))),
	CONSTRAINT "feed_results_review_reason_valid" CHECK ("feed_results"."review_reason" IS NULL OR "feed_results"."review_reason" IN ('cup', 'tennis', 'overdue', 'unreadable'))
);
--> statement-breakpoint
CREATE TABLE "feed_team_aliases" (
	"provider" text NOT NULL,
	"sport_id" text NOT NULL,
	"external_name" text NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_team_aliases_provider_sport_id_external_name_pk" PRIMARY KEY("provider","sport_id","external_name")
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "odds_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feed_leagues" ADD CONSTRAINT "feed_leagues_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_leagues" ADD CONSTRAINT "feed_leagues_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_results" ADD CONSTRAINT "feed_results_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_team_aliases" ADD CONSTRAINT "feed_team_aliases_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_team_aliases" ADD CONSTRAINT "feed_team_aliases_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_api_calls_provider_time_idx" ON "feed_api_calls" USING btree ("provider","called_at");--> statement-breakpoint
CREATE INDEX "feed_leagues_due_odds_idx" ON "feed_leagues" USING btree ("provider","enabled","next_odds_at");--> statement-breakpoint
CREATE INDEX "feed_results_pending_idx" ON "feed_results" USING btree ("provider","first_seen_at") WHERE "feed_results"."applied_at" IS NULL;