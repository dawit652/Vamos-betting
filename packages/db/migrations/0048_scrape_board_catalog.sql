CREATE TABLE "scrape_board_competitions" (
	"board" text NOT NULL,
	"league_key" text NOT NULL,
	"competition_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scrape_board_competitions_board_league_key_pk" PRIMARY KEY("board","league_key"),
	CONSTRAINT "scrape_board_competitions_board" CHECK ("scrape_board_competitions"."board" IN ('hulusport'))
);
--> statement-breakpoint
CREATE TABLE "scrape_board_teams" (
	"board" text NOT NULL,
	"raw_name" text NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scrape_board_teams_board_raw_name_pk" PRIMARY KEY("board","raw_name"),
	CONSTRAINT "scrape_board_teams_board" CHECK ("scrape_board_teams"."board" IN ('hulusport'))
);
--> statement-breakpoint
ALTER TABLE "scrape_board_competitions" ADD CONSTRAINT "scrape_board_competitions_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_board_teams" ADD CONSTRAINT "scrape_board_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scrape_board_competitions_competition_uq" ON "scrape_board_competitions" USING btree ("competition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scrape_board_teams_team_uq" ON "scrape_board_teams" USING btree ("team_id");