CREATE TABLE "bet_cashouts" (
	"bet_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"quoted_gross" bigint NOT NULL,
	"gross" bigint NOT NULL,
	"tax" bigint NOT NULL,
	"net" bigint NOT NULL,
	"margin_bps" integer NOT NULL,
	"legs" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bet_cashouts_amounts" CHECK ("bet_cashouts"."gross" > 0 AND "bet_cashouts"."tax" >= 0 AND "bet_cashouts"."net" >= 0 AND "bet_cashouts"."gross" = "bet_cashouts"."net" + "bet_cashouts"."tax"),
	CONSTRAINT "bet_cashouts_quote_honoured" CHECK ("bet_cashouts"."quoted_gross" > 0 AND "bet_cashouts"."gross" >= "bet_cashouts"."quoted_gross"),
	CONSTRAINT "bet_cashouts_margin_valid" CHECK ("bet_cashouts"."margin_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "bets" DROP CONSTRAINT "bets_settled_amounts";--> statement-breakpoint
ALTER TABLE "bet_cashouts" ADD CONSTRAINT "bet_cashouts_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bet_cashouts" ADD CONSTRAINT "bet_cashouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bet_cashouts_user_idempotency_uq" ON "bet_cashouts" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bet_legs_market_idx" ON "bet_legs" USING btree ("market_id");--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_cashed_out_amounts" CHECK ("bets"."status" <> 'cashed_out' OR ("bets"."settled_gross_payout" > 0 AND "bets"."settled_gross_payout" = "bets"."settled_net_payout" + "bets"."settled_tax"));--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_settled_amounts" CHECK (("bets"."status" NOT IN ('won', 'lost', 'void', 'cashed_out') OR ("bets"."settled_gross_payout" IS NOT NULL AND "bets"."settled_tax" IS NOT NULL AND "bets"."settled_net_payout" IS NOT NULL AND "bets"."settled_at" IS NOT NULL)) AND ("bets"."status" NOT IN ('pending_acceptance', 'open', 'rejected') OR ("bets"."settled_gross_payout" IS NULL AND "bets"."settled_tax" IS NULL AND "bets"."settled_net_payout" IS NULL)));