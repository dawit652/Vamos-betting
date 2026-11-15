CREATE TABLE "competition_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sport_id" text NOT NULL,
	"alias_norm" text NOT NULL,
	"source_id" text,
	"competition_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "competition_aliases_alias_norm" CHECK ("competition_aliases"."alias_norm" <> '' AND "competition_aliases"."alias_norm" = btrim("competition_aliases"."alias_norm"))
);
--> statement-breakpoint
CREATE TABLE "scrape_competition_policy" (
	"competition_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"auto_open" boolean DEFAULT false NOT NULL,
	"auto_results" boolean DEFAULT false NOT NULL,
	"extra_time" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "scrape_observation_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"observation_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_key" text NOT NULL,
	"sport" text NOT NULL,
	"competition_raw" text NOT NULL,
	"home_raw" text NOT NULL,
	"away_raw" text NOT NULL,
	"kickoff" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"round" text,
	"score" jsonb,
	"score_basis" text,
	"payload_hash" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"run_id" uuid NOT NULL,
	"raw_id" uuid,
	CONSTRAINT "scrape_observation_history_kind" CHECK ("scrape_observation_history"."kind" IN ('fixture', 'result')),
	CONSTRAINT "scrape_observation_history_sport" CHECK ("scrape_observation_history"."sport" IN ('football')),
	CONSTRAINT "scrape_observation_history_status" CHECK (("scrape_observation_history"."kind" = 'fixture' AND "scrape_observation_history"."status" IN ('scheduled', 'postponed', 'cancelled')) OR ("scrape_observation_history"."kind" = 'result' AND "scrape_observation_history"."status" IN ('finished', 'cancelled', 'abandoned', 'postponed'))),
	CONSTRAINT "scrape_observation_history_score_basis" CHECK (("scrape_observation_history"."kind" = 'fixture' AND "scrape_observation_history"."score_basis" IS NULL) OR ("scrape_observation_history"."kind" = 'result' AND "scrape_observation_history"."score_basis" IS NOT NULL AND "scrape_observation_history"."score_basis" IN ('regular_time', 'includes_extra_time', 'unknown'))),
	CONSTRAINT "scrape_observation_history_score_presence" CHECK (("scrape_observation_history"."kind" = 'result' AND "scrape_observation_history"."status" = 'finished') = ("scrape_observation_history"."score" IS NOT NULL)),
	CONSTRAINT "scrape_observation_history_score_shape" CHECK ("scrape_observation_history"."score" IS NULL OR (jsonb_typeof("scrape_observation_history"."score") = 'object' AND ("scrape_observation_history"."score"->>'home') ~ '^[0-9]{1,2}$' AND ("scrape_observation_history"."score"->>'away') ~ '^[0-9]{1,2}$' AND (("scrape_observation_history"."score"->>'htHome') IS NULL OR ("scrape_observation_history"."score"->>'htHome') ~ '^[0-9]{1,2}$') AND (("scrape_observation_history"."score"->>'htAway') IS NULL OR ("scrape_observation_history"."score"->>'htAway') ~ '^[0-9]{1,2}$') AND (("scrape_observation_history"."score"->>'htHome') IS NULL) = (("scrape_observation_history"."score"->>'htAway') IS NULL))),
	CONSTRAINT "scrape_observation_history_payload_hash" CHECK ("scrape_observation_history"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "scrape_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_key" text NOT NULL,
	"sport" text NOT NULL,
	"competition_raw" text NOT NULL,
	"home_raw" text NOT NULL,
	"away_raw" text NOT NULL,
	"kickoff" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"round" text,
	"score" jsonb,
	"score_basis" text,
	"payload_hash" text NOT NULL,
	"competition_id" uuid,
	"home_team_id" uuid,
	"away_team_id" uuid,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"run_id" uuid NOT NULL,
	"raw_id" uuid,
	CONSTRAINT "scrape_observations_kind" CHECK ("scrape_observations"."kind" IN ('fixture', 'result')),
	CONSTRAINT "scrape_observations_sport" CHECK ("scrape_observations"."sport" IN ('football')),
	CONSTRAINT "scrape_observations_status" CHECK (("scrape_observations"."kind" = 'fixture' AND "scrape_observations"."status" IN ('scheduled', 'postponed', 'cancelled')) OR ("scrape_observations"."kind" = 'result' AND "scrape_observations"."status" IN ('finished', 'cancelled', 'abandoned', 'postponed'))),
	CONSTRAINT "scrape_observations_score_basis" CHECK (("scrape_observations"."kind" = 'fixture' AND "scrape_observations"."score_basis" IS NULL) OR ("scrape_observations"."kind" = 'result' AND "scrape_observations"."score_basis" IS NOT NULL AND "scrape_observations"."score_basis" IN ('regular_time', 'includes_extra_time', 'unknown'))),
	CONSTRAINT "scrape_observations_score_presence" CHECK (("scrape_observations"."kind" = 'result' AND "scrape_observations"."status" = 'finished') = ("scrape_observations"."score" IS NOT NULL)),
	CONSTRAINT "scrape_observations_score_shape" CHECK ("scrape_observations"."score" IS NULL OR (jsonb_typeof("scrape_observations"."score") = 'object' AND ("scrape_observations"."score"->>'home') ~ '^[0-9]{1,2}$' AND ("scrape_observations"."score"->>'away') ~ '^[0-9]{1,2}$' AND (("scrape_observations"."score"->>'htHome') IS NULL OR ("scrape_observations"."score"->>'htHome') ~ '^[0-9]{1,2}$') AND (("scrape_observations"."score"->>'htAway') IS NULL OR ("scrape_observations"."score"->>'htAway') ~ '^[0-9]{1,2}$') AND (("scrape_observations"."score"->>'htHome') IS NULL) = (("scrape_observations"."score"->>'htAway') IS NULL))),
	CONSTRAINT "scrape_observations_payload_hash" CHECK ("scrape_observations"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "scrape_observations_clock" CHECK ("scrape_observations"."first_seen_at" <= "scrape_observations"."changed_at" AND "scrape_observations"."changed_at" <= "scrape_observations"."last_seen_at"),
	CONSTRAINT "scrape_observations_teams_differ" CHECK ("scrape_observations"."home_team_id" IS NULL OR "scrape_observations"."away_team_id" IS NULL OR "scrape_observations"."home_team_id" <> "scrape_observations"."away_team_id")
);
--> statement-breakpoint
CREATE TABLE "scrape_rating_applied" (
	"fixture_key" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scrape_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"status" integer NOT NULL,
	"content_type" text,
	"content_hash" text NOT NULL,
	"bytes" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"keep" boolean DEFAULT false NOT NULL,
	"records_seen" integer,
	"records_accepted" integer,
	CONSTRAINT "scrape_raw_hash" CHECK ("scrape_raw"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "scrape_raw_sizes" CHECK ("scrape_raw"."bytes" >= 0 AND "scrape_raw"."status" BETWEEN 100 AND 599),
	CONSTRAINT "scrape_raw_yield" CHECK (("scrape_raw"."records_seen" IS NULL OR "scrape_raw"."records_seen" >= 0) AND ("scrape_raw"."records_accepted" IS NULL OR "scrape_raw"."records_accepted" >= 0))
);
--> statement-breakpoint
CREATE TABLE "scrape_review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "scrape_review_items_kind" CHECK ("scrape_review_items"."kind" IN ('unknown_team', 'unknown_competition', 'fixture_conflict', 'kickoff_change', 'fixture_missing', 'cancellation_proposed', 'ratings_uncalibrated', 'odds_approval', 'result_ready', 'result_unverified', 'result_conflict', 'result_correction', 'score_basis_unknown', 'source_broken')),
	CONSTRAINT "scrape_review_items_status" CHECK ("scrape_review_items"."status" IN ('open', 'resolved', 'dismissed')),
	CONSTRAINT "scrape_review_items_severity" CHECK ("scrape_review_items"."severity" IN ('info', 'warning', 'critical')),
	CONSTRAINT "scrape_review_items_resolved" CHECK (("scrape_review_items"."status" = 'open') = ("scrape_review_items"."resolved_at" IS NULL)),
	CONSTRAINT "scrape_review_items_payload_object" CHECK (jsonb_typeof("scrape_review_items"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "scrape_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"records_seen" integer DEFAULT 0 NOT NULL,
	"records_accepted" integer DEFAULT 0 NOT NULL,
	"fixtures" integer DEFAULT 0 NOT NULL,
	"results" integer DEFAULT 0 NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "scrape_runs_status" CHECK ("scrape_runs"."status" IN ('running', 'ok', 'failed', 'broken', 'blocked', 'skipped')),
	CONSTRAINT "scrape_runs_trigger" CHECK ("scrape_runs"."trigger" IN ('schedule', 'manual')),
	CONSTRAINT "scrape_runs_finished" CHECK (("scrape_runs"."status" = 'running') = ("scrape_runs"."finished_at" IS NULL)),
	CONSTRAINT "scrape_runs_counts" CHECK ("scrape_runs"."requests" >= 0 AND "scrape_runs"."bytes" >= 0 AND "scrape_runs"."records_seen" >= 0 AND "scrape_runs"."records_accepted" >= 0 AND "scrape_runs"."fixtures" >= 0 AND "scrape_runs"."results" >= 0),
	CONSTRAINT "scrape_runs_issues_array" CHECK (jsonb_typeof("scrape_runs"."issues") = 'array')
);
--> statement-breakpoint
CREATE TABLE "scrape_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"adapter" text NOT NULL,
	"upstream" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "scrape_sources_adapter" CHECK ("scrape_sources"."adapter" IN ('openfootball', 'generic-json', 'generic-html')),
	CONSTRAINT "scrape_sources_id_format" CHECK ("scrape_sources"."id" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "scrape_sources_upstream_not_empty" CHECK (btrim("scrape_sources"."upstream") <> '')
);
--> statement-breakpoint
CREATE TABLE "team_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sport_id" text NOT NULL,
	"alias_norm" text NOT NULL,
	"source_id" text,
	"team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "team_aliases_alias_norm" CHECK ("team_aliases"."alias_norm" <> '' AND "team_aliases"."alias_norm" = btrim("team_aliases"."alias_norm"))
);
--> statement-breakpoint
ALTER TABLE "competition_aliases" ADD CONSTRAINT "competition_aliases_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_aliases" ADD CONSTRAINT "competition_aliases_source_id_scrape_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."scrape_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_aliases" ADD CONSTRAINT "competition_aliases_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_competition_policy" ADD CONSTRAINT "scrape_competition_policy_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_observation_history" ADD CONSTRAINT "scrape_observation_history_observation_id_scrape_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."scrape_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_observation_history" ADD CONSTRAINT "scrape_observation_history_source_id_scrape_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."scrape_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_observation_history" ADD CONSTRAINT "scrape_observation_history_run_id_scrape_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scrape_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_observations" ADD CONSTRAINT "scrape_observations_source_id_scrape_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."scrape_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_observations" ADD CONSTRAINT "scrape_observations_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_observations" ADD CONSTRAINT "scrape_observations_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_observations" ADD CONSTRAINT "scrape_observations_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_observations" ADD CONSTRAINT "scrape_observations_run_id_scrape_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scrape_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_raw" ADD CONSTRAINT "scrape_raw_run_id_scrape_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scrape_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_runs" ADD CONSTRAINT "scrape_runs_source_id_scrape_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."scrape_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_aliases" ADD CONSTRAINT "team_aliases_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_aliases" ADD CONSTRAINT "team_aliases_source_id_scrape_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."scrape_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_aliases" ADD CONSTRAINT "team_aliases_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competition_aliases_uq" ON "competition_aliases" USING btree ("sport_id","alias_norm",coalesce("source_id", ''));--> statement-breakpoint
CREATE INDEX "competition_aliases_competition_idx" ON "competition_aliases" USING btree ("competition_id");--> statement-breakpoint
CREATE INDEX "scrape_observation_history_obs_idx" ON "scrape_observation_history" USING btree ("observation_id","id");--> statement-breakpoint
CREATE INDEX "scrape_observation_history_seen_idx" ON "scrape_observation_history" USING btree ("seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scrape_observations_key_uq" ON "scrape_observations" USING btree ("source_id","kind","source_key");--> statement-breakpoint
CREATE INDEX "scrape_observations_kind_comp_kickoff_idx" ON "scrape_observations" USING btree ("kind","competition_id","kickoff");--> statement-breakpoint
CREATE INDEX "scrape_observations_source_seen_idx" ON "scrape_observations" USING btree ("source_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "scrape_observations_unresolved_idx" ON "scrape_observations" USING btree ("first_seen_at") WHERE "scrape_observations"."competition_id" IS NULL OR "scrape_observations"."home_team_id" IS NULL OR "scrape_observations"."away_team_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "scrape_raw_run_url_uq" ON "scrape_raw" USING btree ("run_id","url");--> statement-breakpoint
CREATE INDEX "scrape_raw_hash_idx" ON "scrape_raw" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "scrape_raw_prune_idx" ON "scrape_raw" USING btree ("fetched_at") WHERE "scrape_raw"."keep" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "scrape_review_items_open_uq" ON "scrape_review_items" USING btree ("kind","subject_key") WHERE "scrape_review_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX "scrape_review_items_list_idx" ON "scrape_review_items" USING btree ("status","kind","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "scrape_review_items_subject_idx" ON "scrape_review_items" USING btree ("subject_key");--> statement-breakpoint
CREATE INDEX "scrape_runs_source_started_idx" ON "scrape_runs" USING btree ("source_id","started_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_aliases_uq" ON "team_aliases" USING btree ("sport_id","alias_norm",coalesce("source_id", ''));--> statement-breakpoint
CREATE INDEX "team_aliases_team_idx" ON "team_aliases" USING btree ("team_id");