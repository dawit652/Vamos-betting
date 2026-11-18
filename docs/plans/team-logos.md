# Team logos for every team

Owner's request of 17 Nov 2026: "every team should have its logo" next to its name in every match
(the match rows, the featured cards, the event page). Status: **built 17 Nov 2026** (see "As built";
the design below is the plan it came from).

## As built

- **Data**: migration `0056_team_logos`: table `team_logos` (team, API-Football team id, 64 px
  palette PNG, 1 to 4 KB) and `teams.logo_at` / `teams.logo_checked_at`
  (`packages/db/src/catalog/team-logos.ts`).
- **Job**: scraper task `team-logos` (`apps/scraper/src/tasks/team-logos.ts`), every 6 hours, only
  with `SCRAPER_SECRET_API_FOOTBALL`; `SCRAPER_TEAM_LOGOS=off` stops it. Football matches of the next
  2 days with a team without a logo; one `/fixtures?date=` request per kickoff day (at most 3 a pass;
  the fixtures carry the team ids); a match is matched to exactly one fixture as for the board's
  results (kickoff and both names), never guessed. Each logo is downloaded once from
  `media.api-sports.io` (no key, no quota) through the polite fetcher's image mode
  (`FetchPlanItem.accept: 'image'`: PNG, JPEG, WebP, GIF only; robots.txt and the rate limit apply),
  shrunk with sharp (loaded on first use: if it cannot load, only the logos stop). A team not found
  is asked again after 7 days.
- **Serving**: API `GET /teams/:id/logo` (week cache, immutable); `TeamView.logo` is the logo's
  version; the web route `/team-logo/<id>?v=<version>` proxies it (the page's CSP allows only its
  own images).
- **Web**: `TeamIcon` (`apps/web/src/components/sportsbook/TeamIcon.tsx`) in the match rows, the
  featured cards and the event page: the flag of a national team, else the logo, else the initials.
- **Page weight**: the e2e budget page has no logos (the e2e stack has no API-Football key). On the
  live site each club on screen adds 1 to 4 KB the first time (then a week of browser cache); images
  below the screen load only when scrolled to.

## What exists

- National teams show their flag after the name (`apps/web/src/components/sportsbook/team-marks.ts`,
  `teamFlagCodes`); clubs show an initials crest (`monogram`). Competition logos are files in
  `apps/web/public/league-logos/` (API-Football images, owner accepted the trademark risk).
- `teams` (packages/db/src/schema/catalog.ts) has `name`, `short_name`, `country_code`, `ratings`:
  no logo and no API-Football id. Hulusport-only teams are created from names by the scraper.
- API-Football serves club logos at `https://media.api-sports.io/football/teams/<id>.png`
  (checked 17 Nov: Arsenal 42, Chelsea 49, Liverpool 40, Man City 50, Man United 33, Spurs 47,
  Villa 66, West Ham 48, Fulham 36, Wolves 39, Real Madrid 541, Barcelona 529, Bayern 157, PSG 85,
  Juventus 496). The image host needs no key; the API (`v3.football.api-sports.io`) does and has a
  daily quota (the scraper's `SCRAPER_SECRET_API_FOOTBALL`).

## Design

1. **Migration** (next free number, check the journal `when` rule in the handover): table
   `team_logos (team_id uuid pk → teams, api_football_team_id int, png bytea, checked_at, updated_at)`.
   Bytes in the database: backed up with everything else, no new volume. A 64 px PNG is 2 to 4 KB.
2. **Job** (scraper or worker, daily, `SCRAPER_TEAM_LOGOS=on|off`): teams playing in the next 7 days
   with no row, or a row older than 30 days. Find the API-Football id the cheapest way: one
   `/teams?league=<id>&season=<year>` call returns a league's 20 teams with ids (map our
   competitions to API-Football league ids; the board's results already use API-Football); else
   `/teams?search=<name>` within a daily call budget. Match on the normalised name and the country
   (`normalizeName`, `countryCodeOfName`); a weak match is skipped, never guessed. Download the
   image, shrink to 64 px (quantised PNG, like the league logos), store it. National teams: skip
   (they have flags).
3. **Serving**: API `GET /teams/:id/logo` (PNG, `cache-control: public, max-age=604800`), and a web
   route `/team-logo/[id]` that proxies it so the page stays within its CSP (`img-src 'self'`).
4. **Web**: `TeamLine` in `MatchList.tsx`, the featured card and the event page show
   `<img loading="lazy" width=24 height=24>` when the API says the team has a logo (add
   `hasLogo: boolean` to `TeamView` in packages/contracts catalog), else the flag or the crest.
5. **Page weight**: the home page budget is 168 KB (measured 167.4). Visible logos load on first
   paint (about 8 teams × 2 to 3 KB): raise the budget with the measurement, or show logos from
   the second screen on. Ask the owner (mobile data cost in Ethiopia).
6. **Tests**: matching (exact, ambiguous refused, national teams skipped), the job's call budget,
   the API route (cache headers, 404 without logo), the row with and without a logo, budget e2e.

Effort: one session, Opus high (migration, scraper job); the web part is routine.
