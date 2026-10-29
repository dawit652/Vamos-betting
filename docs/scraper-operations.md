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

| Task      | Code                 | Every                 | What it does                                                                                                                                                                                                                                                         | Redis lock                                                         |
| --------- | -------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| scheduler | `tasks/scheduler.ts` | 30 s                  | Decides which **enabled** sources are due and runs them: fetch, archive, parse, shape check, store observations, resolve names.                                                                                                                                      | `scraper:source:<source id>` per source, so two runs never overlap |
| promote   | `tasks/promote.ts`   | 60 s                  | Re-resolves changed aliases and unknown names, promotes fixtures, applies staff-confirmed results, promotes results, then re-prices scheduled events whose teams' ratings changed (rule O3: small moves apply, larger ones wait for a trader as an `odds_approval` ` | reprice` item).                                                    | `scraper:promote`, expires after 5 min |
| prune     | `tasks/prune.ts`     | hourly (not at start) | Deletes raw snapshots older than 30 days, except the evidence behind applied results (section 6).                                                                                                                                                                    | none                                                               |

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

| Variable                         | Default         | Meaning                                                                                             |
| -------------------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `FEED_PROVIDER`                  | `mock`          | adds the value `scraped`                                                                            |
| `SCRAPER_ARCHIVE_DIR`            | `./var/scraper` | raw snapshot store; absolute in licensed mode                                                       |
| `SCRAPER_USER_AGENT`             | `VamosBot/1.0`  | identifies us to sources                                                                            |
| `SCRAPER_CONTACT`                | unset           | URL or email appended to the user agent; **required** when `FEED_PROVIDER=scraped` in licensed mode |
| `SCRAPER_ROBOTS`                 | `enforce`       | `enforce` or `off`; `off` is refused in licensed mode                                               |
| `SCRAPER_PORT`                   | `4200`          | health server (0 = off)                                                                             |
| `SCRAPER_MAX_CONCURRENCY`        | `4`             | parallel hosts                                                                                      |
| `SCRAPER_RESULT_CONFIRM_MINUTES` | `15`            | R4 wait, minimum 5                                                                                  |
| `SCRAPER_MIN_RATING_MATCHES`     | `8`             | O1                                                                                                  |

These are code constants, not settings: the number of independent upstreams a result needs (`MIN_INDEPENDENT_SOURCES = 2`),
the kickoff tolerance, the shape threshold (`SHAPE_MIN_RATIO = 0.5`) and the other rule thresholds in
`packages/scraper/src/constants.ts`. Changing one is a code change and a review, never an operational step.

The scraper's own settings are read at start. Changing one needs `docker compose up -d scraper`.

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

**Competition flags (the four columns on the competitions table).** Each competition has a policy row; a
competition with no row shows all flags off (`configured: false`).

| Flag         | Off means                                                                                                                                                          | On means                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Enabled      | no new event is created; a kickoff change becomes a `kickoff_change` item; an agreed result becomes `result_ready`. Observing and review items go on (shadow mode) | the scraper creates events, moves kickoffs and applies results (subject to the other flags)      |
| Auto open    | new events stay closed for betting; an `odds_approval` item asks a trader to open them                                                                             | a new event opens for betting when its teams are calibrated and the prices pass the sanity check |
| Auto results | a result waits as `result_ready` for a person                                                                                                                      | an agreed result is applied by the scraper (rule R5)                                             |
| Extra time   | (the default) normal rules                                                                                                                                         | the scraper never applies a result by itself (a knockout competition)                            |

Who can change them: turning **Enabled**, **Auto open** or **Auto results** off needs `trading.status` (admin,
trader). Turning any of them on, or changing **Extra time**, needs `settings.edit` (admin only).

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
| `cancellation_proposed` | a source says postponed, cancelled or abandoned                                                                                   | nobody automatically; a person decides by hand in the trading screens                                                                       |

Corrections are never automatic. A correction is made in **Trading**, on the event, with **Enter result**
(`trading.result`), which needs a reason. Scraped data never cancels, voids or abandons an event: a
cancellation is a person's decision, made in Trading with its evidence.

Decisions are recorded in the review item (`resolution`: the decision, the note, the staff id) and in the audit
log. Automatic changes are written with the actor `system:scraper`; staff actions with the staff id.

**Other items a person handles** (not result decisions): `unknown_team` and `unknown_competition` (map an alias,
or dismiss), `odds_approval` (open betting on the proposed prices), `ratings_uncalibrated` (a team has too few
matches to be priced; nothing to do until its ratings are backfilled or a trader sets them), `kickoff_change`
(apply the new time or dismiss), `fixture_conflict` and `fixture_missing` (look at the sources; nothing is
cancelled because a page did not list an event), and `source_broken`.

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
only, never fuzzy). Add one from `/feed/aliases` (the target is a catalogue id) or in bulk with the CLI. The
aliases page has **no removal button** and no command removes an alias yet. A wrong alias is therefore an
engineering task: the removal service (`removeAlias` in `packages/db/src/scrape/aliases.ts`) exists but no
screen calls it (**pending**). Until it is fixed, add a corrected alias for the right spelling and tell an
engineer.

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
