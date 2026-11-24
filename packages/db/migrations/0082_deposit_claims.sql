CREATE TABLE "deposit_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount" bigint NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"reference" text,
	"payer_phone" text,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"credited_intent_id" uuid,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deposit_claims_amount_positive" CHECK ("deposit_claims"."amount" > 0),
	CONSTRAINT "deposit_claims_method" CHECK ("deposit_claims"."method" IN ('telebirr', 'cbe', 'chapa', 'other')),
	CONSTRAINT "deposit_claims_status" CHECK ("deposit_claims"."status" IN ('open', 'credited', 'closed')),
	CONSTRAINT "deposit_claims_resolved" CHECK (("deposit_claims"."status" = 'open') = ("deposit_claims"."resolved_at" IS NULL)),
	CONSTRAINT "deposit_claims_credited" CHECK (("deposit_claims"."status" = 'credited') = ("deposit_claims"."credited_intent_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "deposit_claims" ADD CONSTRAINT "deposit_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_claims" ADD CONSTRAINT "deposit_claims_credited_intent_id_payment_intents_id_fk" FOREIGN KEY ("credited_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposit_claims_user_idx" ON "deposit_claims" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "deposit_claims_open_idx" ON "deposit_claims" USING btree ("created_at") WHERE "deposit_claims"."status" = 'open';