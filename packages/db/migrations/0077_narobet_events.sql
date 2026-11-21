ALTER TABLE "scrape_board_competitions" DROP CONSTRAINT "scrape_board_competitions_board";--> statement-breakpoint
ALTER TABLE "scrape_board_teams" DROP CONSTRAINT "scrape_board_teams_board";--> statement-breakpoint
ALTER TABLE "scrape_board_odds" ADD COLUMN "fixture_id" integer;--> statement-breakpoint
ALTER TABLE "scrape_board_competitions" ADD CONSTRAINT "scrape_board_competitions_board" CHECK ("scrape_board_competitions"."board" IN ('hulusport', 'narobet'));--> statement-breakpoint
ALTER TABLE "scrape_board_teams" ADD CONSTRAINT "scrape_board_teams_board" CHECK ("scrape_board_teams"."board" IN ('hulusport', 'narobet'));