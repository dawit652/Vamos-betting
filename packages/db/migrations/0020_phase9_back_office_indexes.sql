CREATE INDEX "kyc_pending_idx" ON "kyc_profiles" USING btree ("submitted_at") WHERE "kyc_profiles"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "selections_voided_idx" ON "selections" USING btree ("voided_at") WHERE "selections"."voided_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bets_placed_idx" ON "bets" USING btree ("placed_at","id");--> statement-breakpoint
CREATE INDEX "bets_open_idx" ON "bets" USING btree ("placed_at") WHERE "bets"."status" IN ('open', 'pending_acceptance');