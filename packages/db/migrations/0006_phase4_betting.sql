CREATE TYPE "public"."bet_channel" AS ENUM('web', 'sms', 'ussd');--> statement-breakpoint
CREATE TYPE "public"."bet_leg_state" AS ENUM('open', 'won', 'lost', 'void');--> statement-breakpoint
CREATE TYPE "public"."bet_status" AS ENUM('pending_acceptance', 'open', 'won', 'lost', 'void', 'cashed_out', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."bet_type" AS ENUM('single', 'multi');--> statement-breakpoint
CREATE TYPE "public"."odds_change_policy" AS ENUM('none', 'higher', 'any');--> statement-breakpoint
CREATE TABLE "bet_legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bet_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"event_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"selection_id" uuid NOT NULL,
	"odds_milli" integer NOT NULL,
	"requested_odds_milli" integer NOT NULL,
	"is_live" boolean NOT NULL,
	"state" "bet_leg_state" DEFAULT 'open' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bet_legs_odds_valid" CHECK ("bet_legs"."odds_milli" BETWEEN 1001 AND 1000000),
	CONSTRAINT "bet_legs_requested_odds_valid" CHECK ("bet_legs"."requested_odds_milli" BETWEEN 1001 AND 1000000),
	CONSTRAINT "bet_legs_position_non_negative" CHECK ("bet_legs"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"short_id" text NOT NULL,
	"bet_type" "bet_type" NOT NULL,
	"stake" bigint NOT NULL,
	"total_odds_milli" bigint NOT NULL,
	"potential_gross_payout" bigint NOT NULL,
	"potential_bonus" bigint NOT NULL,
	"potential_tax" bigint NOT NULL,
	"potential_net_payout" bigint NOT NULL,
	"bonus_percent_bps" integer DEFAULT 0 NOT NULL,
	"status" "bet_status" NOT NULL,
	"odds_change_policy" "odds_change_policy" NOT NULL,
	"channel" "bet_channel" DEFAULT 'web' NOT NULL,
	"idempotency_key" text NOT NULL,
	"terms" jsonb NOT NULL,
	"settlement_version" integer DEFAULT 0 NOT NULL,
	"settled_gross_payout" bigint,
	"settled_tax" bigint,
	"settled_net_payout" bigint,
	"placed_at" timestamp with time zone NOT NULL,
	"accept_after" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"reject_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bets_short_id_unique" UNIQUE("short_id"),
	CONSTRAINT "bets_stake_positive" CHECK ("bets"."stake" > 0),
	CONSTRAINT "bets_total_odds_valid" CHECK ("bets"."total_odds_milli" >= 1001),
	CONSTRAINT "bets_potential_non_negative" CHECK ("bets"."potential_gross_payout" >= 0 AND "bets"."potential_bonus" >= 0 AND "bets"."potential_tax" >= 0 AND "bets"."potential_net_payout" >= 0),
	CONSTRAINT "bets_settlement_version_non_negative" CHECK ("bets"."settlement_version" >= 0),
	CONSTRAINT "bets_settled_amounts" CHECK (("bets"."status" NOT IN ('won', 'lost', 'void') OR ("bets"."settled_gross_payout" IS NOT NULL AND "bets"."settled_tax" IS NOT NULL AND "bets"."settled_net_payout" IS NOT NULL AND "bets"."settled_at" IS NOT NULL)) AND ("bets"."status" NOT IN ('pending_acceptance', 'open', 'rejected') OR ("bets"."settled_gross_payout" IS NULL AND "bets"."settled_tax" IS NULL AND "bets"."settled_net_payout" IS NULL))),
	CONSTRAINT "bets_settled_non_negative" CHECK ("bets"."settled_net_payout" >= 0 AND "bets"."settled_tax" >= 0 AND "bets"."settled_gross_payout" >= 0),
	CONSTRAINT "bets_pending_accept_after" CHECK ("bets"."status" <> 'pending_acceptance' OR "bets"."accept_after" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "booking_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"legs" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "booking_codes_code_unique" UNIQUE("code"),
	CONSTRAINT "booking_codes_expiry_after_creation" CHECK ("booking_codes"."expires_at" > "booking_codes"."created_at")
);
--> statement-breakpoint
ALTER TABLE "bet_legs" ADD CONSTRAINT "bet_legs_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bet_legs" ADD CONSTRAINT "bet_legs_selection_id_selections_id_fk" FOREIGN KEY ("selection_id") REFERENCES "public"."selections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_codes" ADD CONSTRAINT "booking_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bet_legs_bet_selection_uq" ON "bet_legs" USING btree ("bet_id","selection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bet_legs_bet_position_uq" ON "bet_legs" USING btree ("bet_id","position");--> statement-breakpoint
CREATE INDEX "bet_legs_selection_idx" ON "bet_legs" USING btree ("selection_id");--> statement-breakpoint
CREATE INDEX "bet_legs_event_idx" ON "bet_legs" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bets_user_idempotency_uq" ON "bets" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bets_user_placed_idx" ON "bets" USING btree ("user_id","placed_at","id");--> statement-breakpoint
CREATE INDEX "bets_pending_accept_idx" ON "bets" USING btree ("accept_after") WHERE "bets"."status" = 'pending_acceptance';--> statement-breakpoint
CREATE INDEX "booking_codes_expires_idx" ON "booking_codes" USING btree ("expires_at");