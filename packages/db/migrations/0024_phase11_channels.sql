CREATE TYPE "public"."inbound_message_outcome" AS ENUM('bet_placed', 'bet_refused', 'info', 'opt_out', 'opt_in', 'invalid_command', 'not_available', 'rate_limited');--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregator" text NOT NULL,
	"external_id" text NOT NULL,
	"phone" text NOT NULL,
	"short_code" text,
	"user_id" uuid,
	"text" text NOT NULL,
	"command" text,
	"outcome" "inbound_message_outcome" NOT NULL,
	"refusal_code" text,
	"bet_id" uuid,
	"reply" text,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_messages_bet_placed" CHECK (("inbound_messages"."outcome" = 'bet_placed') = ("inbound_messages"."bet_id" IS NOT NULL)),
	CONSTRAINT "inbound_messages_reply_count" CHECK ("inbound_messages"."reply_count" >= 0 AND ("inbound_messages"."reply" IS NOT NULL OR "inbound_messages"."reply_count" = 0))
);
--> statement-breakpoint
CREATE TABLE "ussd_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregator" text NOT NULL,
	"session_id" text NOT NULL,
	"phone" text NOT NULL,
	"service_code" text NOT NULL,
	"user_id" uuid,
	"state" jsonb NOT NULL,
	"last_text" text NOT NULL,
	"last_response" text NOT NULL,
	"callbacks" integer DEFAULT 1 NOT NULL,
	"bet_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "ussd_sessions_callbacks" CHECK ("ussd_sessions"."callbacks" >= 1)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_marketing_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ussd_sessions" ADD CONSTRAINT "ussd_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ussd_sessions" ADD CONSTRAINT "ussd_sessions_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_messages_external_uq" ON "inbound_messages" USING btree ("aggregator","external_id");--> statement-breakpoint
CREATE INDEX "inbound_messages_phone_idx" ON "inbound_messages" USING btree ("phone","received_at");--> statement-breakpoint
CREATE INDEX "inbound_messages_user_idx" ON "inbound_messages" USING btree ("user_id","received_at");--> statement-breakpoint
CREATE INDEX "inbound_messages_bet_idx" ON "inbound_messages" USING btree ("bet_id") WHERE "inbound_messages"."bet_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ussd_sessions_session_uq" ON "ussd_sessions" USING btree ("aggregator","session_id");--> statement-breakpoint
CREATE INDEX "ussd_sessions_phone_idx" ON "ussd_sessions" USING btree ("phone","created_at");