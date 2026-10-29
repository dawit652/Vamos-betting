# Data scraper

How match data (fixtures, final scores) is collected from outside sources and
turned into catalogue changes without letting a bad read reach money.

**Status:** version 1 is football only: upcoming fixtures and final results.
Live scores and other sports come later. Odds are priced in-house from team
ratings (`packages/feed/src/pricing`); scraped bookmaker odds are never
published.

**Promise.** A scraper cannot promise zero errors: sites change their markup,
publish wrong scores and correct them later. What this design promises is
narrower: _an error is blocked, held for a person, or makes the site stop
taking bets; nothing unchecked reaches money._ Every rule below exists to keep
that sentence true.

## 1. Pipeline

```
sources: sites, JSON endpoints, calendars (and a licensed API as a swappable source)
   │  polite fetch: robots.txt, host allow-list, rate limit, ETag, retries, circuit breaker
   ▼
raw archive (exact bytes + SHA-256 + time) ──► replay / re-parse
   ▼
adapter.parse (pure)  →  observations (zod-checked)  →  shape check (page yield)
   ▼
name resolution (aliases)  ── unknown / ambiguous ──►  review queue
   ▼
scrape_observations (current state per source) + scrape_observation_history (append-only)
   ▼
cluster per fixture  →  rules (sections 6.1 – 6.4)
   ▼   doubtful ──► review queue (a person decides) · or betting stays closed
existing services: upsertFixture · resultEvent · setEventBettingOpen · setSelectionOdds
   ▼
existing platform: markets → bets → settlement → ledger
```

The scraper never writes to the catalogue directly. It can stall the staging
area; it cannot corrupt betting.

## 2. Where the code lives

| Path                                                                   | What                                                                                                           | Owner of the rules |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------ |
| `packages/core/src/scrape.ts`                                          | Shared vocabulary: closed sets of statuses, review kinds, adapter names                                        | –                  |
| `packages/scraper` (`@vamos/scraper`)                                  | Pure toolkit, no database: `fetch`, `archive`, `adapters`, `normalize`, `match`, `gates`, `types`, `constants` | sections 6.1 – 6.6 |
| `packages/db/src/scrape`, `schema/scrape.ts`, migration `0033_*`       | Tables and the services over them                                                                              | section 4          |
| `packages/feed/src/pricing/ratings.ts`                                 | Ratings update from results, price a fixture from ratings                                                      | 6.5                |
| `apps/scraper` (`@vamos/scraper-app`)                                  | The process: scheduler, run pipeline, promotion into the catalogue, health endpoint                            | section 5          |
| `apps/api/src/modules/admin/feed.ts`, `packages/contracts/src/feed.ts` | Back-office API (`/admin/feed/*`)                                                                              | section 8          |
| `apps/admin/src/app/feed`                                              | Back-office pages                                                                                              | section 8          |

`@vamos/scraper` does not import `@vamos/db`, and `@vamos/db` does not import
`@vamos/scraper`: both speak the structural types of `@vamos/core` (`scrape.ts`)
and the interfaces in `packages/scraper/src/types.ts`. Only `apps/scraper`
knows both.

## 3. Observations (`packages/scraper/src/types.ts`)

An adapter turns one document into `FixtureObservation`s and
`ResultObservation`s: what one source said, in its own words.

- Names are raw (`home`, `away`, `competition`). The catalogue is reached only
  through the alias tables (section 6.4).
- `kickoff` is a UTC instant. The adapter converts from the source's local time
  using an explicit IANA zone from its config; it never guesses (rule T1).
- A result carries `scoreBasis`. Only `regular_time` (90 minutes plus
  stoppage, excluding extra time and penalties) can ever settle a bet.
- Everything is validated with the zod schemas in `types.ts` before it leaves
  the adapter. Invalid records are dropped with an issue; they are never
  repaired.
- A score never makes a record `finished`. A generic adapter configured with a
  score must also have a status field with a map; a missing, null or blank
  status uses `status.default` if one is set (never `finished`), otherwise the
  record is dropped with `missing_status`. Only a status the operator mapped to
  `finished` produces a final result.
- `parse` never throws. A page it cannot understand at all yields a `fatal`
  issue and zero records.

## 4. Data model

All tables are in `packages/db/src/schema/scrape.ts`; names are normative,
column details may be refined by the implementer (documented in the schema).
Text columns with a closed set get a CHECK constraint built from
`packages/core/src/scrape.ts`.

| Table                                 | Purpose                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrape_sources`                      | `id` text PK, `name`, `adapter` (`SCRAPE_ADAPTERS`), `upstream`, `config` jsonb (adapter config incl. `allowedHosts`, requests, `timeZone`, competition label, `scoreBasis`), `enabled` (default **false**), timestamps, `updated_by`                                                              |
| `scrape_competition_policy`           | `competition_id` PK → competitions, `enabled` (default false), `auto_open` (default false), `auto_results` (default false), `extra_time` (default false), `updated_at`, `updated_by`                                                                                                               |
| `scrape_runs`                         | one fetch+parse cycle of a source: `id`, `source_id`, `started_at`, `finished_at`, `status` (`SCRAPE_RUN_STATUSES`), `trigger` (`schedule`/`manual`), `requests`, `bytes`, `records_seen`, `records_accepted`, `fixtures`, `results`, `issues` jsonb (capped), `error`                             |
| `scrape_raw`                          | a stored snapshot: `id`, `run_id`, `url`, `status`, `content_type`, `content_hash` (SHA-256 hex), `bytes`, `fetched_at`, `keep` (result evidence is never pruned)                                                                                                                                  |
| `scrape_observations`                 | current state per `(source_id, kind, source_key)`: raw names, resolved `competition_id` / `home_team_id` / `away_team_id` (nullable until resolved), `sport`, `kickoff`, `status`, `score` jsonb, `score_basis`, `payload_hash`, `first_seen_at`, `last_seen_at`, `changed_at`, `run_id`, `raw_id` |
| `scrape_observation_history`          | **append-only** (trigger + `REVOKE UPDATE, DELETE` from the app role): every distinct payload an observation had, with `seen_at`, `run_id`, `raw_id`. The evidence behind a settlement                                                                                                             |
| `team_aliases`, `competition_aliases` | normalised raw name → catalogue id, optionally limited to one `source_id` (null = any source). Unique per `(sport/normalised name/source)`                                                                                                                                                         |
| `scrape_review_items`                 | what a person must look at: `kind` (`SCRAPE_REVIEW_KINDS`), `subject_key`, `status`, `severity`, `title`, `payload` jsonb, `created_at`, resolution fields. At most one **open** item per `(kind, subject_key)` (partial unique index)                                                             |
| `scrape_rating_applied`               | `fixture_key` PK, `applied_at`: a result updates ratings at most once                                                                                                                                                                                                                              |

Events created by the scraper have `feed_provider = 'scraped'` and
`feed_ref = fixture key` (`fx|competitionId|homeTeamId|awayTeamId|YYYY-MM-DD`
of the first kickoff). The key never changes, not even when the match is
rescheduled; matching to the event goes through rule F3.

New append-only tables must `REVOKE UPDATE, DELETE` from the app role in the
same migration (`packages/db/test/app-role.test.ts` checks it).

## 5. The runner (`apps/scraper`)

- Same shape as the worker: `loadConfig()`, a database handle, Redis, pino,
  tasks started and stopped in order, `/health` and `/ready` on
  `SCRAPER_PORT`.
- One scheduler task decides which sources are due (cadence below), and runs
  each under a Redis lock `scraper:source:<id>` so two instances never fetch
  the same source at once.
- A **run** = plan → fetch (polite) → archive → parse → shape check → store
  observations → resolve names → record the run. A run that is `broken`
  stores nothing and opens a `source_broken` item.
- **Promotion** (fixtures, results, ratings) is a separate task over the stored
  observations. It applies the rules and then calls the existing catalogue
  services inside one transaction per event, with the event row locked, and
  writes an audit record (`actor` = `SCRAPER_ACTOR`). After commit it publishes
  the live deltas the services return (as the worker does).
- Everything is idempotent: re-running any step changes nothing.
- Cadence (proposed, tune in shadow mode): fixtures every 15 min; results
  every 5 min from kickoff + 90 min until the event is resulted, otherwise
  every 60 min.
- Not in version 1: live scores, headless-browser fetching.

## 6. Rules (normative)

Every rule has an id; tests cite the id in their names. Constants are in
`packages/scraper/src/constants.ts`.

### 6.1 Fixtures

- **F1 Identity.** Resolved observations are clustered by
  `(competitionId, homeTeamId, awayTeamId)` and kickoff proximity: after sorting
  by kickoff, an observation joins the previous cluster if it is within
  `CLUSTER_WINDOW_MS` of it. Home and away are never swapped to make a match.
- **F2 Create.** A cluster creates an event only if: the competition policy is
  `enabled`; at least one observation says `scheduled`; the kickoff is within
  `(now + MIN_LEAD_MS, now + FIXTURE_HORIZON_MS]`; and the sources that saw it
  agree on the kickoff within `KICKOFF_TOLERANCE_MS`. Otherwise `fixture_conflict`
  (or nothing, when the fixture is simply outside the window).
- **F3 Match an existing event.** Among scraped events with the same
  competition, home and away whose start is within `MATCH_WINDOW_MS` of the
  cluster: exactly one → that event (a reschedule keeps its `feed_ref`); none →
  new; more than one → `fixture_conflict` (ambiguous), nothing applied. Creating is
  insert-only: if an event with the new fixture's `feed_ref` exists after all
  (rescheduled further than `MATCH_WINDOW_MS` away), nothing is changed and a
  `fixture_conflict` (`feed_ref_exists`) opens.
- **F4 Kickoff change.** For a `scheduled` event whose cluster kickoff differs by
  more than `KICKOFF_TOLERANCE_MS`: apply if (a) at least
  `MIN_INDEPENDENT_SOURCES` independent upstreams agree on the new time, or (b)
  one source, and the shift is later, at most `SMALL_SHIFT_MS`, and the event
  has no bets. A move to an earlier time, with bets on the event, needs (a). A
  new time before `now + MIN_LEAD_MS` is never applied. Anything else →
  `kickoff_change`. The move is re-checked under the event's row lock (still
  scheduled, still starting at the time the decision was taken, and for (b) still
  without bets); if anything changed, nothing is applied and the next pass decides
  again.
- **F4c Several clusters, one fixture.** Sources that differ by more than
  `CLUSTER_WINDOW_MS` form several clusters (F1). If they match the same open
  event (F3), or the same pairing is unknown and the clusters lie within
  `MATCH_WINDOW_MS` of each other, none of them is decided: one `kickoff_change`
  (`sources_disagree`) or `fixture_conflict` is opened and nothing is moved or
  created. A cluster decided alone would flip the kickoff on every pass or
  create the fixture twice.
- **F5 Absence never cancels.** A fixture missing from a source changes
  nothing. An event no enabled source has listed in a successful run for
  `MISSING_AFTER_MS` opens `fixture_missing`. Nothing is cancelled because a
  page did not contain it.
- **F6 Postponed / cancelled** statuses are never applied automatically: they
  void bets. They open `cancellation_proposed` with the sources that said so.
- **F7 Betting stays closed.** A new event is created with betting **closed**.
  It is opened automatically only if the competition policy has `auto_open`, both
  teams are calibrated (rule O1) and the prices pass O2. Otherwise it opens
  `odds_approval` (teams calibrated) or `ratings_uncalibrated` (not), and a
  trader opens betting.

### 6.2 Results

- **R1 Eligible.** Only events with status `scheduled` (scraped events never go
  live), not yet resulted, and `now >= kickoff + MIN_MATCH_DURATION_MS`.
- **R2 Agreement.** A result is confirmed only if at least
  `MIN_INDEPENDENT_SOURCES` distinct **upstreams** each have a current
  `finished` observation for the fixture, with `scoreBasis = regular_time`, and
  identical full-time scores. If the event `needsHalfTimeScore`, the half-time
  score must also be present and identical in those observations. Sources that
  share an upstream count once.
- **R3 Dissent blocks.** Any current observation from any source with status
  `finished` and a different score, or with status `cancelled` / `abandoned` /
  `postponed`, blocks the result and opens `result_conflict`. A source that has
  not caught up (still `scheduled`) is not dissent.
- **R4 Stability.** An agreed result is applied only after every agreeing
  observation has been unchanged for the configured confirmation time
  (`DEFAULT_RESULT_CONFIRM_MS`, never below `MIN_RESULT_CONFIRM_MS`) and no
  observation changed to a conflicting state in that time.
- **R5 Apply.** With the competition's `auto_results` on, the policy `enabled`
  and `extra_time` off, apply with `resultEvent(status 'finished')`; otherwise
  open `result_ready` (with the exposure, R9) and a trader confirms. A policy
  that is switched off (S4) or has `extra_time` (a source wrongly configured as
  regular time could pass a longer-play score off) never applies by itself.
  Same service either way.
- **R6 Single source.** A final score from only one upstream, still alone
  `UNVERIFIED_AFTER_MS` after the earliest possible end, opens
  `result_unverified`. A trader can apply it, audited as an override.
- **R7 No automatic cancel/void.** Results with status `cancelled`,
  `abandoned` or `postponed` are never applied automatically (they void bets):
  `cancellation_proposed`.
- **R8 Corrections.** After an event is resulted, any current `finished`
  observation with a different score opens `result_correction`. A correction
  reverses payouts, so it is never applied automatically.
- **R9 Impact.** A review item that asks for a result decision carries the
  event's exposure: open bets and total stake (decimal strings of santim).
- **R10 Basis.** A `finished` observation whose `scoreBasis` is not
  `regular_time` never counts towards R2; it opens `score_basis_unknown`
  once per fixture.
- **R11 Idempotent.** Applying a result again changes nothing.

### 6.3 Source health

- **S1 Shape.** After parsing, `recordsAccepted` is compared with the median of
  the source's last `SHAPE_BASELINE_RUNS` successful runs for the same URL, once
  there are `SHAPE_MIN_BASELINE_RUNS`. Fewer than `SHAPE_MIN_RATIO` of the
  baseline, zero where the baseline is positive, or any `fatal` issue →
  `broken`: nothing is stored, `source_broken` opens, and the source is skipped
  until a run is healthy again.
- **S1a Conditional requests.** A `304 Not Modified` is a sighting of the page
  stored last time: the run records a raw row with that page's hash and yield and
  moves `last_seen_at` / `run_id` / `raw_id` of the observations that page
  produced (so "last listed", F5, keeps up with a page that does not change). A
  304 with no accepted copy stored is a failed run. The validators (ETag,
  Last-Modified) of a page that was not accepted (`broken`, or storing it failed)
  are forgotten, so the next request is unconditional; `source_broken` is closed
  only by a run that parsed at least one page.
- **S2 Transport.** Non-2xx and network errors are `failed` (retried with
  backoff by the fetcher, circuit breaker per source). A robots.txt refusal or
  a block page is `blocked`: we back off; we do not work around it.
- **S3 Allow-list.** The fetcher refuses any host not in the adapter's
  `allowedHosts`, after every redirect.
- **S4 Manual stop.** `scrape_sources.enabled = false` and
  `scrape_competition_policy.enabled = false` stop the scraper immediately and
  are available to traders in the back office. A disabled competition policy
  stops everything the scraper does by itself there: no event is created, no
  kickoff is moved (a change that would be applied opens `kickoff_change`
  instead) and no result is applied (an agreed score opens `result_ready`);
  observing and raising review items go on (shadow mode).

### 6.4 Names and time

- **N1 Normalisation.** NFKC → lower-case → strip diacritics → `&` to `and` →
  drop punctuation → collapse spaces → drop the tokens `fc cf sc afc bsc` at the
  start or end only.
- **N2 Exact only.** A raw name resolves only when its normalised form equals
  an alias (source-specific alias first, then global) or a catalogue name /
  short name of the sport. Never fuzzy. If it maps to more than one team it is
  ambiguous and unresolved.
- **N3 Suggestions.** Unresolved names open `unknown_team` /
  `unknown_competition` with up to three suggested catalogue matches (token
  similarity). Suggestions are for people; they are never applied.
- **T1 Time zones.** `zonedToUtc` uses an explicit IANA zone. A local time that
  does not exist (DST gap) or is ambiguous (DST overlap) is rejected with an
  issue; the record is dropped. Never guessed.

### 6.5 Odds

- **O1 Calibrated teams.** Both teams' `ratings` must carry `matches >=
MIN_RATING_MATCHES` (or `manual = 1`, set by a trader). Neutral default
  ratings are never used to price real bets.
- **O2 Sane prices.** Prices come from `priceMatch(matchStrengths(...))`. Before
  a market is stored or opened: every price is a valid odds value; where the
  selections partition the outcomes, the overround lies in
  `[OVERROUND_MIN, OVERROUND_MAX]`.
- **O3 Re-pricing.** After ratings change, scheduled events are re-priced only if
  no selection moves by more than `MAX_PRICE_MOVE_RATIO` in either direction;
  otherwise the old prices stay and `odds_approval` opens with the proposal.
- **O4 Ratings update.** A confirmed result updates both teams' ratings once
  (`scrape_rating_applied`), in the same transaction as the result.

### 6.6 Scraping manners

One identifying `User-Agent` with a contact; robots.txt enforced (licensed mode
refuses to turn it off); per-host minimum interval with jitter; conditional
requests; `Retry-After` honoured; response size and time limits; no login, no
CAPTCHA or bot-protection circumvention, no proxy rotation to evade blocks.
Each source's terms are checked by a person before it is enabled.

## 7. Configuration

Added to `packages/config` (all optional unless noted; env names are
normative):

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

There is **no** setting for the number of sources a result needs: it is the
constant `MIN_INDEPENDENT_SOURCES = 2`.

## 8. Back office

Routes under `/admin/feed/*`, contracts in `packages/contracts/src/feed.ts`, with
the same table-of-routes-and-permissions pattern as `COMPLIANCE_ROUTE_PERMISSIONS`.
Existing permissions are reused (no new ones):

| Route                                                                       | Permission                                                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /admin/feed/health` (sources, last runs, queue counts)                 | `trading.view`                                                                          |
| `GET /admin/feed/review`, `GET /admin/feed/review/:id`                      | `trading.view`                                                                          |
| `POST /admin/feed/review/:id/resolve` – open betting, dismiss, map alias    | `trading.status`                                                                        |
| … same route applying a **result** (`result_ready`, `result_unverified`)    | `trading.result`                                                                        |
| `GET /admin/feed/aliases`, `POST /admin/feed/aliases`                       | `trading.view` / `trading.status`                                                       |
| `PUT /admin/feed/sources/:id` – enable or disable (kill switch)             | `trading.status`                                                                        |
| `GET /admin/feed/competitions`, `PUT /admin/feed/competitions/:id` – policy | `trading.view` / `settings.edit` (turning a policy **off** needs only `trading.status`) |

Every mutation is audited with the staff actor. Resolving a result applies it
through the same function as automatic promotion, so the rules R1, R8–R11 hold
for people too (a person may override R2/R6 only through `result_unverified` /
`result_ready`). Before it is applied the confirmation is
re-checked against the current observations (kickoff within tolerance, no
dissent on full time or on the half time an event needs, a half time present when
the event needs one); a failed check rejects it, audits
`scrape.result.confirmation_rejected` and opens a fresh item.

## 9. Testing requirements

- Pure modules: unit tests plus property tests (`fast-check`), as for
  `packages/core`.
- Parsers: golden files of real documents under `src/adapters/__fixtures__`,
  including postponements, abandonments, extra time, penalties, duplicate team
  names and DST changes.
- No test touches the network: a fake `fetch` (or a local HTTP server) only.
  Clocks, randomness and sleeps are injected.
- Integration tests use a real Postgres (`createTestDatabase`).
- Fault injection: timeouts, 429/503 with `Retry-After`, truncated bodies,
  empty pages, block pages, changed markup, partial pagination. After each, assert
  that nothing bad reached the catalogue (above all: no event is cancelled,
  no result applied).
- End to end: a recorded fixture list and result set through the whole pipeline
  into settlement on a real Postgres, asserting ledger totals.

## 10. Rollout

1. **Shadow mode.** Sources enabled, every competition policy off: the
   scraper stores observations and opens review items but creates nothing.
   2–4 weeks; compare against a ground truth.
2. Enable fixtures for one competition with `auto_open` off (a trader opens
   betting after looking at the odds).
3. Results through `result_ready` (a person confirms each), then
   `auto_results` per competition after a run of matches with full agreement.
4. Only then consider `auto_open`.

A licensed data provider can replace or join a scraped source without any
change downstream: it is one more adapter with its own `upstream`.

## 11. Working agreements for contributors

- Stay inside the files your task owns; the shared types are in
  `packages/scraper/src/types.ts` and `packages/core/src/scrape.ts` and change
  only by agreement.
- Money is `bigint` santim and odds are integer milli (see `CLAUDE.md`); scores
  are small integers.
- Every automated change is idempotent and audited.
- Prefer failing closed: when unsure, open a review item and change nothing.
