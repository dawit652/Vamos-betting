CREATE TABLE "report_days" (
	"business_date" date PRIMARY KEY NOT NULL,
	"totals" jsonb NOT NULL,
	"totals_hash" text NOT NULL,
	"closing" jsonb NOT NULL,
	"checks" jsonb NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "report_days_hash_hex" CHECK ("report_days"."totals_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
-- A closed report day is written once and read: the app may never change or remove it.
REVOKE UPDATE, DELETE, TRUNCATE ON "report_days" FROM vamos_app;
