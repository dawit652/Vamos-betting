CREATE TABLE "cashier_staff_shops" (
	"staff_id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cashier_staff_shops" ADD CONSTRAINT "cashier_staff_shops_staff_id_admin_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashier_staff_shops" ADD CONSTRAINT "cashier_staff_shops_shop_id_cashier_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."cashier_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashier_staff_shops" ADD CONSTRAINT "cashier_staff_shops_assigned_by_admin_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cashier_staff_shops_shop_idx" ON "cashier_staff_shops" USING btree ("shop_id");