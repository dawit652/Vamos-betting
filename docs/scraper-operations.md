# Scraper operations

How to run the data scraper day to day: what runs, what to check, how to stop it, how results reach the
catalogue, and what evidence is kept. The design and the rules are in [`scraper.md`](scraper.md); the
step-by-step procedures are in the [runbooks](runbooks/README.md):

- [Feed source broken or blocked](runbooks/feed-source-broken.md)
- [Feed result disputed](runbooks/feed-result-disputed.md)
- [Adding a new feed source](runbooks/feed-new-source.md)

The scraper never writes to the catalogue directly. It can stall the staging area and open review items. It
never cancels, voids or abandons an event, and it applies a result by itself only when the competition allows it
and the sources agree (section 5).

## 1. What runs

The scraper is one process (`apps/scraper`, entry `src/main.ts`, built to `dist/main.js`). In production it
is the `scraper` service of [`infra/docker-compose.prod.yml`](../infra/docker-compose.prod.yml). Run **one**
instance. It has three tasks (`apps/scraper/src/tasks/index.ts`), started in this order:

| Task      | Code                 | Every                 | What it does                                                                                                                                                                                                                                                                      | Redis lock                                                         |
| --------- | -------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| scheduler | `tasks/scheduler.ts` | 30 s                  | Decides which **enabled** sources are due and runs them: fetch, archive, parse, shape check, store observations, resolve names.                                                                                                                                                   | `scraper:source:<source id>` per source, so two runs never overlap |
| promote   | `tasks/promote.ts`   | 60 s                  | Re-resolves changed aliases and unknown names, promotes fixtures, applies staff-confirmed results, promotes results, then re-prices scheduled events whose teams' ratings changed (rule O3: small moves apply, larger ones wait for a trader as a re-price `odds_approval` item). | `scraper:promote`, expires after 5 min                             |
| prune     | `tasks/prune.ts`     | hourly (not at start) | Deletes raw snapshots older than 30 days, except the evidence behind applied results (section 6).                                                                                                                                                                                 | none                                                               |

**Polling cadence** (`packages/scraper/src/fetch/cadence.ts`):

- fixtures: every 15 minutes;
- results: every 5 minutes from kickoff + 90 minutes to kickoff + 6 hours, otherwise every 60 minutes;
- a source with failed runs in a row waits twice as long per failure, up to 6 hours (`backoffAfterFailures`).

A run may start up to 10% early to spread the load (`scheduler.ts`). A failing source whose last run asked us to
wait (a `Retry-After`) is not run before that time.

**Health and logs**

- `GET /health` (liveness) and `GET /ready` (database and Redis answer) on `SCRAPER_PORT` (default 4200). The
  port is not published. Check it with `scripts/smoke.sh --scraper <url>` as in
  [deployment](deployment.md#3-deploying-the-compose-stack).
- `/ready` says nothing about the sources. Source health is on the back office `/feed` page (section 3).
- Logs are JSON lines on stdout: `docker compose logs -f --tail 200 scraper`. Errors and fatals:
  `docker compose logs --since 30m scraper | grep -E '"level":(50|60)'`.
- Stopping is graceful: shutdown waits up to 60 seconds for source runs in progress (the compose
  `stop_grace_period` is 75 seconds).

## 2. Settings

The scraper reads these from the environment (`packages/config/src/config.ts`; examples in
[`.env.example`](../.env.example)). In licensed mode, `FEED_PROVIDER=scraped` also needs an absolute
`SCRAPER_ARCHIVE_DIR`, a `SCRAPER_CONTACT` and `SCRAPER_ROBOTS=enforce`; the guard refuses to start otherwise.

| Variable                         | Default          | Meaning                                                                                             |
| -------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| `FEED_PROVIDER`                  | `mock`           | adds the value `scraped`                                                                            |
| `SCRAPER_ARCHIVE_DIR`            | `./var/scraper`  | raw snapshot store; absolute in licensed mode                                                       |
| `SCRAPER_USER_AGENT`             | `NahubetBot/1.0` | identifies us to sources                                                                            |
| `SCRAPER_CONTACT`                | unset            | URL or email appended to the user agent; **required** when `FEED_PROVIDER=scraped` in licensed mode |
| `SCRAPER_ROBOTS`                 | `enforce`        | `enforce` or `off`; `off` is refused in licensed mode                                               |
| `SCRAPER_PORT`                   | `4200`           | health server (0 = off)                                                                             |
| `SCRAPER_MAX_CONCURRENCY`        | `4`              | parallel hosts                                                                                      |
| `SCRAPER_RESULT_CONFIRM_MINUTES` | `15`             | R4 wait, minimum 5                                                                                  |
| `SCRAPER_MIN_RATING_MATCHES`     | `8`              | O1                                                                                                  |

These are code constants, not settings: the number of independent upstreams a result needs (`MIN_INDEPENDENT_SOURCES = 2`),
the kickoff tolerance, the shape threshold (`SHAPE_MIN_RATIO = 0.5`) and the other rule thresholds in
`packages/scraper/src/constants.ts`. Changing one is a code change and a review, never an operational step.

The scraper's own settings are read at start. Changing one needs `docker compose up -d scraper`.

API keys of sources are not settings of this table: they are the `SCRAPER_SECRET_<NAME>` variables of
section 7.

## 3. Daily and weekly checks

### Daily: the back office `/feed` page

Open **Feed** in the back office (`/feed`). Staff with `trading.view` can read it.

1. **Sources.** Every enabled source should be `ok`, or `learning` (fewer than three successful runs so far). Act on:
   - `broken` (the page arrived but its shape changed, nothing was stored): [feed source broken](runbooks/feed-source-broken.md);
   - `blocked` (robots.txt refused, a block page, or a rate limit): the same runbook, and do not work around it;
   - `stale` (no successful run for three hours): check the scraper's logs and `/ready`;
   - `disabled`: expected only for a source someone switched off on purpose.
2. **Review queue.** The header shows the open count, the breakdown by kind is below it, and each kind links to
   its list (`/feed/review?status=open&kind=<kind>`). Read the **Age** column: no open `unknown_team` or
   `unknown_competition` item should be older than seven days (the shadow-mode target in
   [plan 07](scraper-plan/07-sources-ratings-and-shadow-mode.md)). Result items are read the same day (section 5).
3. **Competitions.** The flags for each competition (section 4). Nothing should be on that no one has decided
   to turn on.

There are no alert thresholds on these numbers yet (**pending**): the check is by eye.

### Weekly: trends

- **Parse yield.** The `/feed` table shows only the last run (accepted over seen). For a trend, read the
  successful runs of the last week (read-only, on the production stack):

  ```bash
  docker compose exec postgres psql -U vamos -d vamos -c "select source_id, date_trunc('day', started_at) as day, count(*) as runs, avg(records_accepted)::int as avg_accepted from scrape_runs where status = 'ok' and started_at > now() - interval '7 days' group by 1, 2 order by 1, 2"
  ```

  A fall towards half of the usual yield is the signal the shape check acts on (`SHAPE_MIN_RATIO`, 0.5): look at it
  before the source is marked `broken`.

- **Agreement.** No metric exists yet (**pending**). Count the week's result items instead:

  ```bash
  docker compose exec postgres psql -U vamos -d vamos -c "select kind, status, count(*) from scrape_review_items where kind like 'result_%' and created_at > now() - interval '7 days' group by 1, 2 order by 1, 2"
  ```

  Many `result_conflict` or `result_unverified` items mean the sources disagree or one source is down.

- **Archive size.** Size of the raw snapshot store (the `scraper_archive` volume) and of the last backup:

  ```bash
  docker compose exec scraper du -sh /var/lib/vamos/scraper
  ls -lh /var/backups/vamos/scraper/
  ```

  The archive only grows with the 30-day prune of unkept snapshots (section 6). Plan the disk with that growth.

## 4. Kill switches

Two switches, both in the back office `/feed` page. Neither cancels, voids or changes an existing bet.

**Source switch (Enable / Disable on a source row).** Disabling a source stops the scheduler polling it at
once, and its current observations stop voting straight away (they are hidden from the promotion by default).
What it already stored stays in the archive. Enabling it again resumes polling. Disabling needs `trading.status`
(admin, trader). `sources upsert` never changes the flag of an existing source (see [adding a new feed source](runbooks/feed-new-source.md)).

**Competition flags (the four columns on the competitions table, and the "Prices from" select).** Each competition has a policy row; a
competition with no row shows all flags off (`configured: false`).

| Flag         | Off means                                                                                                                                                          | On means                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Enabled      | no new event is created; a kickoff change becomes a `kickoff_change` item; an agreed result becomes `result_ready`. Observing and review items go on (shadow mode) | the scraper creates events, moves kickoffs and applies results (subject to the other flags)      |
| Auto open    | new events stay closed for betting; an `odds_approval` item asks a trader to open them                                                                             | a new event opens for betting when its teams are calibrated and the prices pass the sanity check |
| Auto results | a result waits as `result_ready` for a person                                                                                                                      | an agreed result is applied by the scraper (rule R5)                                             |
| Extra time   | (the default) normal rules                                                                                                                                         | the scraper never applies a result by itself (a knockout competition)                            |

Who can change them: turning **Enabled**, **Auto open** or **Auto results** off needs `trading.status` (admin,
trader). Turning any of them on, or changing **Extra time**, needs `settings.edit` (admin only).

**Prices from (select).** `Team ratings (model)` is the default and what every competition uses until a
person changes it; `Bookmaker feed first` is section 8. Switching to the feed needs `settings.edit` (admin
only); switching back to the model needs only `trading.status`. Neither changes an existing price at once: the
next re-pricing pass looks at each event (a big change waits as an `odds_approval` item for a trader).

**Stop the whole scraper.** `docker compose stop scraper` stops fetching and promotion. Nothing is changed in
the catalogue by stopping it, and what was stored stays. Betting on events that are already open carries on
as normal, so stop the scraper **and** turn the competition's **Enabled** flag off if the problem is a bad
feed. Restart with `docker compose start scraper`.

## 5. How results reach the catalogue

A result is an agreed final score from at least two independent upstreams (the rules R1 to R11 in
[`scraper.md`](scraper.md#62-results)). What happens next depends on the competition's flags and the item:

| Item                    | Raised when                                                                                                                       | Applied by                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| (none, applied)         | agreed, unchanged for the confirmation time (15 min by default), no dissent, competition enabled, auto results on, extra time off | the scraper, through the same service a trader uses                                                                                         |
| `result_ready`          | agreed, but auto results is off or the competition is not enabled                                                                 | a person: **Apply this result** on the item (`trading.result`, admin or trader). The server applies the score in the item, not one typed in |
| `result_unverified`     | only one upstream has a final score, still alone six hours after the earliest possible end                                        | a person, as an override, audited. "Unverified" means exactly this: one source, not confirmed by a second                                   |
| `result_conflict`       | a current observation disagrees (score, half time, kickoff, or a source says postponed, cancelled or abandoned)                   | nobody automatically; a person decides (runbook)                                                                                            |
| `result_correction`     | an applied result is now contradicted by a source                                                                                 | nobody automatically; a correction reverses payouts (runbook)                                                                               |
| `result_overdue`        | the match should be over (kickoff + 7 h 45 min), no source has a score and no other result item is open (rule R12)                | a person: look the score up on an official site and enter it in **Trading** (`trading.result`); the item closes by itself afterwards        |
| `cancellation_proposed` | a source says postponed, cancelled or abandoned                                                                                   | nobody automatically; a person decides by hand in the trading screens                                                                       |

Corrections are never automatic. A correction is made in **Trading**, on the event, with **Enter result**
(`trading.result`), which needs a reason. Scraped data never cancels, voids or abandons an event: a
cancellation is a person's decision, made in Trading with its evidence.

Decisions are recorded in the review item (`resolution`: the decision, the note, the staff id) and in the audit
log. Automatic changes are written with the actor `system:scraper`; staff actions with the staff id.

**Other items a person handles** (not result decisions): `unknown_team` and `unknown_competition` (map an alias,
or dismiss), `odds_approval` (open betting on the proposed prices), `ratings_uncalibrated` (a team has too few
matches to be priced; nothing to do until its ratings are backfilled or a trader sets them with `ratings set`), `kickoff_change`
(apply the new time or dismiss), `fixture_conflict` and `fixture_missing` (look at the sources; nothing is
cancelled because a page did not list an event), `source_broken` (a source's pages stopped parsing as before) and
`source_stale` (a source still answers but has shown nothing new since a match it lists ended 48 hours ago or more, so
no result can come from it: check the source's own page; results for those matches come from another source or are
entered by hand in Trading; the item closes by itself when the source moves, and dismissing it silences it for 24 hours).

**Who can do what**

| Action                                                   | Permission       | Roles         |
| -------------------------------------------------------- | ---------------- | ------------- |
| Enable or disable a source                               | `trading.status` | admin, trader |
| Dismiss, map an alias, open betting, apply a new kickoff | `trading.status` | admin, trader |
| Create an alias (`/feed/aliases`)                        | `trading.status` | admin, trader |
| Apply a result (`result_ready`, `result_unverified`)     | `trading.result` | admin, trader |
| Enter or correct a result in Trading                     | `trading.result` | admin, trader |
| Competition flag off (enabled, auto open, auto results)  | `trading.status` | admin, trader |
| Competition flag on, or extra time                       | `settings.edit`  | admin         |

The feed pages need `trading.view`, which only the admin and trader roles hold; other staff roles cannot open them.

**Aliases.** An alias maps a source's spelling of a team or competition to the catalogue (rule N2: exact match
only, never fuzzy). Add one from `/feed/aliases` (the target is a catalogue id) or in bulk with the CLI. To
remove a wrong one, use the **Remove** button on `/feed/aliases` (it asks for a second click; it needs
`trading.status`, so other staff roles do not see it), or the CLI: `aliases list --q <name>` shows the ids and
`aliases remove --id <id>` removes one. Both are audited (`scrape.alias.removed`). The observations already stored
keep what they resolved to until the promotion pass runs again (within a minute), which re-resolves them; names
that no longer resolve reappear as `unknown_team` or `unknown_competition` items. Add the correct alias afterwards
(an alias that points elsewhere is refused until the old one is removed).

**Ratings by hand.** A trader calibrates a team that has no history with `ratings set --team <name> --attack <n>
--defence <n>` (section 12 of [scraper.md](scraper.md)); there is no screen for ratings. `ratings list` shows what
is stored and which teams are manual.

**Command line in production.** The database is not published, so the commands run in the scraper image:
`docker compose run --rm --no-deps scraper node dist/cli.js <command>`, with files mounted read-only (`-v
"$PWD/file:/in/file:ro"`). Details and an example are in [scraper.md](scraper.md#production).

**Why is betting closed?** `feed report [--days <n>] [--json]` is read-only (it never writes): it lists the
competition policies, the sources, the open review queue by kind and reason, and each upcoming scraped match whose
betting is closed with the reasons in plain English. Run it with
`docker compose run --rm -T --no-deps scraper node dist/cli.js feed report`, or on a compose deployment with
`infra/scripts/feed-report.sh` (same options), which sets the compose files itself.

## 6. Evidence and retention

The scraper's evidence is what makes a result explainable after the fact. Three stores:

| Store                                                          | What                                                                                                                                                                                                     | Kept                                                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw snapshots: `scrape_raw` rows and the archive files         | Every fetched page: exact bytes (gzip), SHA-256 hash, time, status, records seen and accepted. Files live under `<archive>/<hash 1-2>/<hash 3-4>/<hash>.gz` and are checked against their hash when read | Pruned after **30 days** by the prune task, **except** every snapshot marked `keep` (the pages behind an applied result) and any file a kept row still refers to |
| Observation history: `scrape_observation_history`              | Every distinct payload an observation had, with when and from which run and snapshot. Append-only: the application role cannot update or delete it (database guard)                                      | Not pruned by any task                                                                                                                                           |
| Review items and audit log: `scrape_review_items`, `audit_log` | Every item raised, its decision and note; every scraper and staff change                                                                                                                                 | Not pruned; `audit_log` is append-only                                                                                                                           |

**Backups.** The raw snapshot store is backed up as a tarball of the `scraper_archive` volume:
`infra/scripts/backup.sh scraper` (included in `backup.sh all`). Scraper archives are never deleted by
`backup.sh prune`, and must be kept as long as the bets they support (at least the seven years of the ledger;
see [backups](backups.md#4-retention)). A restore drill can check one archive with
`infra/scripts/restore-drill.sh` (see [backups](backups.md#5-restore-drill)).

**What a lost snapshot means.** The database row stays, but the bytes behind an applied result are gone, so it
can no longer be shown or replayed. Treat a missing archive as an incident (severity by its impact on settled
bets) and restore it from backup before anything else. Do not re-fetch the page to replace it: the live page
has changed.

## 7. API keys of sources

A source with a licensed API (API-Football, `x-apisports-key`) names an environment variable in its config:
`"auth": { "header": "x-apisports-key", "secret": "SCRAPER_SECRET_API_FOOTBALL" }` (rules in
[scraper.md](scraper.md) 6.7). The config and the database hold that **name**; the key itself lives in one place.

- **Where the key lives.** In the deployment environment of the **scraper service only**: `SCRAPER_SECRET_API_FOOTBALL`
  in `infra/.env.prod` (mode `0600`, never in git; the template line in `infra/env.prod.example` is commented out),
  passed to the `scraper` service by `infra/docker-compose.prod.yml`. The api, worker and migrate jobs do not get
  it. A second key needs its own `SCRAPER_SECRET_<NAME>` line in both files. Locally, `.env` (see `.env.example`).
- **Adding it.** Put the key in `infra/.env.prod`, `docker compose up -d scraper`, then
  `docker compose run --rm --no-deps -v "$PWD/source.json:/in/source.json:ro" scraper node dist/cli.js dry-fetch --source-file /in/source.json`.
  The one-off container has the same environment as the service. The output shows the parsed fixtures and never the key.
- **Rotation.** Change the variable in `infra/.env.prod` and restart the scraper: `docker compose up -d scraper`
  (the environment is read when a source is fetched, but a container only gets a changed `.env.prod` when it is
  recreated). No config edit, no migration, nothing in the database changes. Revoke the old key at the vendor after
  the first `ok` run of the source. Rotate after anyone who could read `.env.prod` leaves, and on any suspicion.
- **If the variable is missing or empty** the source's run fails **before any request** with the issue
  `secret_missing` (it names the variable, never a value) and the run's error says the same; `/feed` shows the
  source failing. `secret_invalid` means the value has a line break or non-ASCII characters; fix the line in
  `.env.prod` (no quotes needed, no trailing text).
- **If a response contains the key** (the vendor echoes request headers) the run fails with `secret_echoed` and the
  response is neither archived nor parsed. That is a reason to ask the vendor, not to work around it.
- **Where the value never goes.** Logs, run issues, review items, the audit trail, `scrape_sources`, the raw archive
  and the CLI output. A key that was pasted into a source file by mistake is refused by `sources upsert`; if one
  ever reached a ticket, chat or git, treat it as leaked and rotate it.
- **football-data.org (Premier League kickoffs and results).** `docs/scraper-plan/data/source-footballdata-en1.json`
  reads the v4 matches of the Premier League with the free plan's token (`X-Auth-Token`,
  `SCRAPER_SECRET_FOOTBALL_DATA`). Its kickoffs carry the TV moves that the openfootball file leaves on the Saturday
  15:00 placeholder (rule K1 then closes betting on a match that really starts earlier), and its scores arrive
  minutes after the final whistle. On a compose deployment `infra/scripts/use-football-data.sh` asks for the token
  (hidden), runs `dry-fetch` against the real API and only then restarts the scraper and adds the source, disabled.
  In the back office, enable it and disable `openfootball-en1` (a disabled source's observations stop counting at
  once), then apply the `kickoff_change` items. The golden file of its test is synthetic in the v4 shape; replace it
  with a captured response. Check football-data.org's terms before any use beyond a private demo.
- **Bundesliga, LaLiga, Serie A, Ligue 1 from the same token.** `source-footballdata-{de1,es1,it1,fr1}.json` are the
  same config for the codes BL1, PD, SA and FL1. The catalogue holds every 2026-27 club of the five leagues;
  `aliases-footballdata-top-leagues.csv` maps football-data.org's spellings that are not catalogue names (TSG 1899
  Hoffenheim, FC Internazionale Milano, Real Betis Balompié…). `infra/scripts/add-top-leagues.sh` rebuilds the
  migrate and scraper images, seeds the new clubs, imports the aliases and, per league, runs `dry-fetch`, adds the
  source (disabled) and learns the clubs' ratings from this season's finished matches (`ratings backfill`, which
  resolves names through global aliases too). The token reaches curl on stdin, never on a command line. A new
  season's promoted clubs are a catalogue change (`packages/db/src/seed/catalog.ts`) plus, where needed, an alias.
- **The Odds API as the second upstream (fixtures, results, prices).** The 20K plan is paid. The five
  `source-theoddsapi-<league>.json` read prices and, with `"fixtures": true`, report every upcoming match at the
  bookmakers' `commence_time`: with football-data.org that is two independent upstreams, so a kickoff both agree on
  moves without a person (F4a). It lists no finished match, so it is never a fresh source for K2: a kickoff is
  confirmed by football-data.org alone from 72 hours before the start (C2), and F7b then opens betting by itself in
  a competition with **auto open** on. The five `source-theoddsapi-scores-<league>.json`
  (`mode: "scores"`, `/scores?daysFrom=3`, 2 credits a read, so a match missed for up to three days is still read) report final scores: with football-data.org a result
  both agree on settles by itself in a competition with **auto results** on (R2; the half time, needed only by
  `ht_1x2`, comes from football-data.org). A scores source is read only from kickoff + 110 minutes to kickoff + 4 h
  of one of its own league's unresulted matches (20/30/60 minutes by credit-guard mode, never in stop): about
  1,500 to 2,000 credits a month on top of the prices. Neither kind counts as records for S1 (`acceptCompanion`).
  `aliases-theoddsapi.csv` holds the five club spellings that are not catalogue names. `infra/scripts/use-odds-api.sh`
  rebuilds migrate and scraper, imports the spellings and adds or updates the ten sources (new ones disabled).
  Market pricing (`pricing: market` per competition) prices from the bookmakers' consensus and falls back to the
  model where the market is thin.
- **UEFA Champions League.** `source-footballdata-cl.json` (code CL, the catalogue's own competition name) reads the
  score basis per match from `score.duration`: a knockout score after extra time or penalties is
  `includes_extra_time` and never settles a bet (R10, `score_basis_unknown`: enter the 90-minute score in Trading).
  The catalogue holds the 2026-27 league phase's 15 clubs from leagues it does not offer (`EUROPEAN_CLUBS`), with
  hand-set ratings on the top leagues' scale: ratings learned in a weaker league would overrate its champion.
  `infra/scripts/add-champions-league.sh` rebuilds migrate and scraper, seeds them, imports the spellings
  (`aliases-footballdata-champions-league.csv`), runs `dry-fetch`, adds the source (disabled) and marks the
  newcomers' ratings as reviewed. In the back office switch the competition's **extra time** on (no result is
  applied without a person) and leave **auto open** off: prices between leagues deserve a look.

## 8. Pricing from a licensed odds feed

A competition can take its prices from the licensed odds feed (TheRundown) instead of the team-rating
model ([scraper.md](scraper.md) rule O5). The default is the model. Before the first switch, in this order:

1. **The licence.** The provider has confirmed **in writing** that an operator may use its prices to set its own
   prices (plan gate G2 in [scraper-plan/10-market-odds-feed.md](scraper-plan/10-market-odds-feed.md)). Without
   it, do not enable the source: the feed's prices must not be used, even for a check.
2. **A real response.** The adapter was written from the documented shape; its test file is synthetic. Put the
   key in `SCRAPER_SECRET_THERUNDOWN` (section 7), write the source file (`adapter: therundown`, `secret`,
   `sports: [{ sportId, competition }]`), and run `dry-fetch --source-file ...` with the same environment. Read the
   output (a `prices` line per match, with each bookmaker's 1X2 and over/under as decimal odds) against one real match on the provider's own site: the **price format** (`priceFormat`, american or
   decimal: a wrong choice makes the page fail, never gives wrong prices silently), the **sport id** of the
   league, the **period** of the full match (`periodId`), the market ids (`moneylineMarketId`, `totalsMarketId`),
   and the draw name. Fix the source file, not the code; if the real shape differs, stop and ask a developer.
3. **Enable the source** (`sources upsert`, then Enable on `/feed`) and let it run for a day. Check that runs are
   `ok`, that the fixtures resolve (no new unknown-name items), and that prices arrive:
   `SELECT count(*), max(observed_at) FROM scrape_market_odds WHERE event_id IS NOT NULL;` (rows with a null
   `event_id` are matches we have no event for yet).
4. **Switch one competition** on `/feed`: "Prices from" to `Bookmaker feed first`. One competition first, a
   quiet one. Within a minute or two its events with at least two bookmakers get new prices (small changes
   apply by themselves; a big one waits as an `odds_approval` item named `<match>|reprice` with a `pricing`
   line "market: N books, fit residual x"). Compare a few prices with the provider's site before widening.

Running it: the feed is read on the source's usual schedule; prices last listed more than 3 hours ago are not used. If the
feed stops, events already priced from it **keep their prices** (nothing jumps back to the model); events not yet
priced from it stay on the model. To stop using the feed for a competition, set "Prices from" back to
`Team ratings (model)`: the next pass prices its events from ratings again, through the same bounds. To stop
everything at once, disable the feed's source (Enable / Disable): its prices stop counting immediately.

Never in this flow: scraped (unlicensed) bookmaker prices, opening betting by itself (a trader still opens
betting), anything cancelling, voiding or settling from prices.
