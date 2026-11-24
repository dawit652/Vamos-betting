CREATE TABLE "service_status" (
	"service" text PRIMARY KEY NOT NULL,
	"last_ok_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"alerted_down_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
