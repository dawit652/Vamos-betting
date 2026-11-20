CREATE TYPE "public"."collection_account_status" AS ENUM('pending', 'active', 'rejected', 'deleted');--> statement-breakpoint
CREATE TABLE "collection_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"institution" text NOT NULL,
	"account" text NOT NULL,
	"name" text NOT NULL,
	"hint" text,
	"status" "collection_account_status" DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone,
	"deleted_by" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "collection_accounts_four_eyes" CHECK ("collection_accounts"."decided_by" IS NULL OR "collection_accounts"."created_by" IS NULL OR "collection_accounts"."decided_by" <> "collection_accounts"."created_by"),
	CONSTRAINT "collection_accounts_decided" CHECK ("collection_accounts"."status" NOT IN ('active', 'rejected') OR "collection_accounts"."created_by" IS NULL OR "collection_accounts"."decided_at" IS NOT NULL),
	CONSTRAINT "collection_accounts_pending" CHECK ("collection_accounts"."status" <> 'pending' OR ("collection_accounts"."decided_by" IS NULL AND "collection_accounts"."decided_at" IS NULL)),
	CONSTRAINT "collection_accounts_deleted" CHECK (("collection_accounts"."status" = 'deleted') = ("collection_accounts"."deleted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_decided_by_admin_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_updated_by_admin_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_accounts" ADD CONSTRAINT "collection_accounts_deleted_by_admin_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_accounts_account_id_uq" ON "collection_accounts" USING btree ("account_id") WHERE "collection_accounts"."status" IN ('pending', 'active');--> statement-breakpoint
CREATE UNIQUE INDEX "collection_accounts_number_uq" ON "collection_accounts" USING btree ("institution","account") WHERE "collection_accounts"."status" IN ('pending', 'active');--> statement-breakpoint
-- Collection accounts are records: deleting one in the back office only marks it deleted.
REVOKE DELETE ON collection_accounts FROM vamos_app;
