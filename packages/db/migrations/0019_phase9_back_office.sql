ALTER TABLE "admin_sessions" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "failed_login_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "selections" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_email_lower" CHECK ("admin_users"."email" = lower("admin_users"."email"));--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_failed_attempts" CHECK ("admin_users"."failed_login_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_voided_is_void" CHECK ("markets"."voided_at" IS NULL OR "markets"."status" = 'void');--> statement-breakpoint
ALTER TABLE "selections" ADD CONSTRAINT "selections_voided_is_void" CHECK ("selections"."voided_at" IS NULL OR ("selections"."status" = 'settled' AND "selections"."result" = 'void'));