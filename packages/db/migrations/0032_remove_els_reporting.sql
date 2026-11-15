-- Removes the Ethiopian regulator (ELS) reporting: the transaction stream
-- (els_reports), the daily summaries and their versions, the guard
-- functions of migration 0023 and the leftover ELS cursor and commission
-- setting. CASCADE drops the tables' triggers.
DROP TABLE "daily_summaries" CASCADE;--> statement-breakpoint
DROP TABLE "daily_summary_versions" CASCADE;--> statement-breakpoint
DROP TABLE "els_reports" CASCADE;--> statement-breakpoint
DROP TYPE "public"."daily_summary_status";--> statement-breakpoint
DROP TYPE "public"."els_report_status";--> statement-breakpoint
DROP FUNCTION IF EXISTS vamos_guard_els_report();--> statement-breakpoint
DROP FUNCTION IF EXISTS vamos_guard_daily_summary();--> statement-breakpoint
DELETE FROM compliance_cursors WHERE name = 'els_outbox';--> statement-breakpoint
DELETE FROM settings WHERE key = 'els_commission';
