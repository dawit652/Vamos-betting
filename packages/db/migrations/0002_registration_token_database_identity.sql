CREATE TYPE "public"."operating_mode" AS ENUM('demo', 'licensed');--> statement-breakpoint
CREATE TABLE "database_identity" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"operating_mode" "operating_mode" NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_identity_singleton" CHECK ("database_identity"."id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "registration_token_hash" text;