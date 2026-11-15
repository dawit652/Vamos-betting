-- Data scraper guards (docs/scraper.md section 4), enforced by the database itself behind the
-- services in packages/db/src/scrape. scrape_observation_history is the evidence behind every
-- result the catalogue accepted from scraped data, so it is APPEND-ONLY:
--   1. BEFORE UPDATE OR DELETE rejects every row change (vamos_reject_mutation, see 0001).
--   2. BEFORE TRUNCATE rejects the statement (as 0023 does for the compliance tables).
--   3. The app role keeps INSERT and SELECT only (the second lock; see 0030 and
--      packages/db/test/app-role.test.ts, which fails for an append-only table without it).

CREATE TRIGGER scrape_observation_history_append_only
  BEFORE UPDATE OR DELETE ON scrape_observation_history
  FOR EACH ROW EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER scrape_observation_history_no_truncate
  BEFORE TRUNCATE ON scrape_observation_history
  FOR EACH STATEMENT EXECUTE FUNCTION vamos_reject_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON scrape_observation_history FROM vamos_app;
