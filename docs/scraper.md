# Data scraper

How match data (fixtures, final scores) is collected from outside sources and
turned into catalogue changes without letting a bad read reach money.

**Status:** version 1 is football only: upcoming fixtures and final results.
Live scores and other sports come later. Odds are priced in-house from team
ratings (`packages/feed/src/pricing`); a competition can be set to take its
prices from a licensed odds feed first (section 1, rule O5). Scraped
(unlicensed) bookmaker odds are never published.

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

**Decision change, 2026-10-31.** Until then every price came from our own team-rating
model and bookmaker odds were only ever a check. By the owner's decision, a competition
may now be set to take its prices from a **licensed** odds feed (a paid API with a
written licence for operator use; today TheRundown): when the feed has a fresh consensus
for an event, our prices follow it, with our own margin. The model stays the fallback and
the default: nothing changes for a competition until a person switches it. What did not
change: scraped (unlicensed) bookmaker odds are still never published, bookmaker prices
never settle, void or cancel anything, and every price change still passes the same
bounds, sanity checks and trader approval (rule O5).

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
  stoppage, excluding extra time and penalties) can ever settle a bet. A
  `generic-json` config states it for the whole source (`scoreBasis`) and may
  read it per record (`fields.scoreBasis`: a `path` and a `map` of the record's
  values to a basis, e.g. football-data.org's `score.duration` with `REGULAR`,
  `EXTRA_TIME`, `PENALTY_SHOOTOUT`); a value outside the map gives `unknown`
  with a warning, a missing value the source's `scoreBasis`.
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

### 3.1 Bookmaker prices (`market_odds`)

A licensed odds feed (adapter `therundown`, kind `licensed_api`) also produces
`MarketOddsObservation`s: what ONE bookmaker offered for ONE selection of ONE match
(football 1X2, and the over/under total on a half-point line), as integer milli rounded
down, with the feed's own `priceUpdatedAt`. They are stored in `scrape_market_odds` (one
row per source, match, bookmaker, market, line and selection: the state as of the last
fetch that listed it; a `304` counts as listing it again; rows not listed for 7 days are
deleted). Names are resolved with the same aliases as fixtures; a row is linked to the
event of the same competition and teams that starts within `MARKET_ODDS_LINK_WINDOW_MS`
of its kickoff, when there is exactly one (the promotion pass links the rows of events
created after the prices were read). Freshness is when WE last saw the price listed
(`observed_at`), not the price's own time: a price that has not moved for 12 hours is
current if the latest fetch lists it. A bookmaker the latest fetch no longer lists, and
an event the latest successful run no longer lists, drop out; a disabled source never
counts. Prices are used only by rule O5; they are never shown, never copied into a
market, and never an input to results.

**The Odds API (adapter `theoddsapi`, `docs/theoddsapi-plan/README.md`).** One source per
league; it yields price rows only (no fixtures, no results: the openfootball sources keep
those). One request per run to `/v4/sports/{sportKey}/odds` for `h2h` and `totals` of up to
ten named bookmakers costs 2 credits; the key travels only in the `x-api-key` header. Live
matches and matches beyond `horizonDays` are skipped, outcomes are matched by exact name,
only x.5 lines with both sides are kept, and a market whose `last_update` is over
`maxBookAgeMinutes` (20) old or in the future is dropped. Its requests have purpose `odds`:
they are read by the next kickoff in the source's own price rows (every 10 min within 3 h,
30 min within 24 h, 2 h within 14 days, else 6 h), slowed by the **credit guard** of its key
(economy, minimal, stop: computed each scheduler pass from the `api_credits_*` columns of the
key's runs this month). Its alarms are `source_broken` items with the reasons `budget_low`,
`budget_exhausted`, `unauthorized`, `unexpected_cost` and `market_stale` (runbook
`docs/runbooks/odds-credits-low.md`); the back-office `/feed` page shows each key's credits
and mode. The licensed-mode switch it once had (rule L3) was removed on the owner's decision.

## 4. Data model

All tables are in `packages/db/src/schema/scrape.ts`; names are normative,
column details may be refined by the implementer (documented in the schema).
Text columns with a closed set get a CHECK constraint built from
`packages/core/src/scrape.ts`.

| Table                                 | Purpose                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrape_sources`                      | `id` text PK, `name`, `adapter` (`SCRAPE_ADAPTERS`), `upstream`, `config` jsonb (adapter config incl. `allowedHosts`, requests, `timeZone`, competition label, `scoreBasis`), `enabled` (default **false**), timestamps, `updated_by`                                                              |
| `scrape_competition_policy`           | `competition_id` PK → competitions, `enabled` (default false), `auto_open` (default false), `auto_results` (default false), `extra_time` (default false), `pricing_source` (`model` default, or `market`, rule O5), `updated_at`, `updated_by`                                                     |
| `scrape_market_odds`                  | bookmaker prices of a licensed feed (section 3.1): `source_id`, `source_key`, `bookmaker`, `market`, `line`, `selection`, `price_milli`, `price_updated_at`, `observed_at`, resolved ids and `event_id` (nullable until linked), `run_id`, `raw_id`                                                |
| `scrape_runs`                         | one fetch+parse cycle of a source: `id`, `source_id`, `started_at`, `finished_at`, `status` (`SCRAPE_RUN_STATUSES`), `trigger` (`schedule`/`manual`), `requests`, `bytes`, `records_seen`, `records_accepted`, `fixtures`, `results`, `issues` jsonb (capped), `error`                             |
| `scrape_raw`                          | a stored snapshot: `id`, `run_id`, `url`, `status`, `content_type`, `content_hash` (SHA-256 hex), `bytes`, `fetched_at`, `keep` (result evidence is never pruned)                                                                                                                                  |
| `scrape_observations`                 | current state per `(source_id, kind, source_key)`: raw names, resolved `competition_id` / `home_team_id` / `away_team_id` (nullable until resolved), `sport`, `kickoff`, `status`, `score` jsonb, `score_basis`, `payload_hash`, `first_seen_at`, `last_seen_at`, `changed_at`, `run_id`, `raw_id` |
| `scrape_observation_history`          | **append-only** (trigger + `REVOKE UPDATE, DELETE` from the app role): every distinct payload an observation had, with `seen_at`, `run_id`, `raw_id`. The evidence behind a settlement                                                                                                             |
| `team_aliases`, `competition_aliases` | normalised raw name → catalogue id, optionally limited to one `source_id` (null = any source). Unique per `(sport/normalised name/source)`                                                                                                                                                         |
| `scrape_review_items`                 | what a person must look at: `kind` (`SCRAPE_REVIEW_KINDS`), `subject_key`, `status`, `severity`, `title`, `payload` jsonb, `created_at`, resolution fields. At most one **open** item per `(kind, subject_key)` (partial unique index)                                                             |
| `scrape_rating_applied`               | `fixture_key` PK, `applied_at`: a result updates ratings at most once                                                                                                                                                                                                                              |
| `scrape_event_pricing`                | `event_id` PK, `ratings_key` (fingerprint of the ratings behind the stored prices, null if unknown), `priced_at`, `held_key` (the fingerprint of the last proposal a person was asked about), `updated_at` (rule O3)                                                                               |

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
  one source, and the shift is later, at most `SMALL_SHIFT_MS`, the event
  has no bets **and betting is closed** (K4: with betting open the change is a
  `kickoff_change` with reason `betting_open`, severity warning). A move to an
  earlier time, with bets on the event, needs (a). A
  new time before `now + MIN_LEAD_MS` is never applied. Anything else →
  `kickoff_change`. The move is re-checked under the event's row lock (still
  scheduled, still starting at the time the decision was taken, and for (b) still
  without bets and with betting still closed); if anything changed, nothing is applied
  and the next pass decides again. Every `kickoff_change` the gate writes carries the
  contract's fields (`eventId`, `currentKickoff`, `proposedKickoff`, `sources` as
  `{sourceId, upstream, changedAt}` sorted by source id, `hasBets`) next to its own, so
  "Apply new kickoff" can read it. The gate's open `kickoff_change` of an event (subject
  `<feedRef>`) closes by itself, resolved by the scraper and audited, once its cause is gone: on
  the next pass in which every source agrees with the event's kickoff again, in the transaction
  of a move (F4a, F4b), or once the event has a result or is live or over. A postponed or
  cancelled event keeps its item, and K1's `<feedRef>|earlier` item is another subject, never
  closed here. A stale proposal is not left open for a person to apply.
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
  teams are calibrated (rule O1), the prices pass O2 and the kickoff is confirmed
  (K2). Otherwise it opens
  `odds_approval` (teams calibrated; reason `kickoff_unconfirmed` when only the
  kickoff stopped an `auto_open` event) or `ratings_uncalibrated` (not), and a
  trader opens betting. When the teams of an
  event created uncalibrated become calibrated and its prices follow their
  ratings, the re-price step (O3) resolves `ratings_uncalibrated` itself
  (`{"decision":"calibrated"}`) and opens `odds_approval`; the re-price step itself never opens
  betting (F7b may, once the kickoff is confirmed).
- **F7b Automatic opening later.** An event created 14 days ahead from one source cannot have a
  confirmed kickoff at creation (K2: C1 needs two independent fresh upstreams, C2 the last
  `KICKOFF_CONFIRM_LEAD_MS`), so F7 is applied again on every promotion pass (last step). Betting
  opens on a scraped, `scheduled`, unresulted event with betting closed that starts after
  `now + MIN_LEAD_MS` when, at that moment: its competition policy is enabled with `auto_open`; it
  waits for a person (its `odds_approval` item, or K1's `<feedRef>|earlier` item, is open); no
  person decided on its betting (the latest of the audits `catalog.event.betting_opened`,
  `catalog.event.betting_closed`, `scrape.fixture.betting_closed` and
  `scrape.fixture.betting_opened` is none, or K1's automatic closure); no F4 `kickoff_change` is
  open for it; no re-price of it is held for a person (`<feedRef>|reprice`, O3: its stored prices
  are not the current ones); its kickoff is confirmed (K2), so an earlier report K1 acted on is
  gone; and O1 (or O1m) and O2 pass. Under the event row lock, then the locks of its review items (the order
  of K1, the re-price step and the review actions), everything is read again; the
  writes are `betting_open = true` (no actor), the audit `scrape.fixture.betting_opened`
  (`rule: 'F7b'`, the basis, the evidence key, `afterK1`, `calibration`) and the waiting items resolved by the
  scraper; the live delta is published after the COMMIT. A trader's close, a dismissed item, a
  held re-price or `auto_open` off keeps the event closed.

### 6.1a Kickoff safety (K1 to K6)

Design, measurements and tests: `docs/scraper-plan/kickoff-safety.md`. Prematch betting on an event closes
by itself at `events.start_time` and scraped events never go live, so the exposure is exactly this: betting
is open and the real kickoff is earlier than our `start_time`. Nothing here changes results, statuses,
prices or bets. The pure rules are in `packages/scraper/src/gates/kickoff.ts` (`assessKickoff`,
`earlierKickoffAction`).

Definitions (used by every rule below):

- **Listed row.** A row of `scrape_observations` of an enabled source with `last_seen_at` at or after the
  `started_at` of that source's latest run with status `ok` (a 304 sighting counts). A row a source no longer
  lists, such as the old-day row a keyless source leaves when a match moves, is not listed.
- **Statement** about event E: a listed row, of kind fixture or result, with E's competition, home and away
  and a kickoff at most `KICKOFF_EVIDENCE_WINDOW_MS` before or after `E.start_time`.
- **Agreeing statement:** a `scheduled` fixture within `KICKOFF_TOLERANCE_MS` of the start. Any other
  statement **dissents**: a scheduled fixture further away, a `postponed` or `cancelled` fixture, any result
  statement.
- **Earlier-kickoff statement:** a `scheduled` fixture or a `finished` result whose kickoff lies in
  `[start - KICKOFF_EVIDENCE_WINDOW_MS, start - KICKOFF_TOLERANCE_MS)`; it may be in the past. Postponed,
  cancelled and abandoned statements are never earlier-kickoff statements (K5).
- **Fresh source:** its latest finished run is `ok`; _known_ (a listed row ended at least
  `MIN_MATCH_DURATION_MS + SOURCE_STALE_AFTER_MS` ago; a source with nothing ended cannot be judged) and
  _not stale_ (S5 computed on the source's own rows, not read from the `source_stale` item).
- **Independent upstreams:** `countIndependent` over the statements' upstreams, as in F2 and R2.
- **Person record:** the latest audit row `scrape.fixture.kickoff_confirmed` of the event
  (`startTime`, `confirmedAt`, `evidenceKey`). A statement is _acknowledged_ when the record names exactly the
  event's current `start_time` and `statement.changed_at <= confirmedAt`; a record for another start is
  ignored, so any kickoff move voids it.
- **Confirmed kickoff** at `now`: **C1** no dissenting statement and agreeing statements of fresh sources
  from at least `MIN_INDEPENDENT_SOURCES` independent upstreams; or **C2** no dissenting statement,
  `now >= start - KICKOFF_CONFIRM_LEAD_MS` and an agreeing statement of a fresh source with
  `changed_at <= now - KICKOFF_STABLE_MS`; or **C3** a person record for this start and every dissenting
  statement acknowledged.
- **Evidence key:** SHA-256 (hex) of the canonical JSON array `[startISO, statements]`, statements sorted by
  source id, kind and kickoff, each `[sourceId, kind, status, kickoffISO, changedAtISO]`: it names exactly
  what a person was shown.

| Constant                     | Value  | Used by    |
| ---------------------------- | ------ | ---------- |
| `KICKOFF_CONFIRM_LEAD_MS`    | 72 h   | C2         |
| `KICKOFF_STABLE_MS`          | 24 h   | C2         |
| `KICKOFF_EVIDENCE_WINDOW_MS` | 7 days | statements |

Reused: `KICKOFF_TOLERANCE_MS`, `MIN_INDEPENDENT_SOURCES`, `SOURCE_STALE_AFTER_MS`, `MIN_MATCH_DURATION_MS`,
`MIN_LEAD_MS`.

- **K1 Earlier kickoff closes betting.** For a scraped, `scheduled`, unresulted event with
  `betting_open = true` and `start_time > now` that has an earlier-kickoff statement nobody acknowledged, the
  scraper, in one transaction under the event's row lock that re-reads the event and the evidence, sets
  `events.betting_open = false` (no actor: automatic) and nothing else (markets, selections, prices,
  `start_time`, `status` and bets are not touched; bets already placed stand), writes the audit
  `scrape.fixture.betting_closed` (`rule: 'K1'`, the earlier statements, the evidence key) and opens or
  refreshes the critical `kickoff_change` item with subject `<feedRef>|earlier`, a separate subject so the F4
  item cannot overwrite it. It publishes the `match` delta after COMMIT. K1 runs whatever the confirmation
  basis and acts only on open betting.
- **K2 No opening on an unconfirmed kickoff.** Betting on a scraped event is opened only if its kickoff is
  confirmed (C1, C2 or C3) at that moment and it starts later than `now + MIN_LEAD_MS`: F7 automatic opening
  (the gate input `kickoffConfirmed`; otherwise the event is created closed with an `odds_approval` item,
  reason `kickoff_unconfirmed`), the review item's "Open betting" and the Trading switch (422
  `kickoff_too_close`, 422 `kickoff_unconfirmed` with the statements and the evidence key; a person confirms
  by sending the key they were shown, C3). Closing betting is never checked; events of other feeds are not
  affected. Reasons: `no_statement`, `earlier_kickoff_reported`, `sources_disagree`, `void_status_reported`,
  `result_reported`, `source_not_fresh`, `too_early_for_single_source`, `not_stable`.
- **K3 Confirmation opens betting only through F7.** Confirmation is computed when someone tries to open, by
  F7 at creation and by F7b on every pass, and is not stored. When a kickoff becomes confirmed later, F7b
  opens an event that waits for a person only while its competition has `auto_open` and nobody decided on
  its betting (2026-11: `auto_open` was creation-only, so every event created from one source stayed
  closed until a trader opened it). A confirmation does not survive a kickoff move.
- **K4 Later kickoffs.** F4 is kept with one tightening: F4b (one source, later, at most `SMALL_SHIFT_MS`, no
  bets) also needs betting **closed**; with betting open it is a `kickoff_change` with reason `betting_open`
  (warning). F4a (independent upstreams agree) still applies with betting open.
- **K5 Void statuses stay with a person.** Postponed, cancelled and abandoned statements never trigger K1,
  never change a status and never void anything (F6 and R7 unchanged); they only make the kickoff
  unconfirmed.
- **K6 Idempotent and race-safe.** K1 changes something only while `betting_open` is true, so a second pass
  with the same data changes nothing (no audit, no item refresh). The scraper and the API take the event row
  lock and re-read event, statements and person record inside the transaction before deciding.

### 6.2 Results

- **R1 Eligible.** Only events with status `scheduled` (scraped events never go
  live), not yet resulted, and `now >= kickoff + MIN_MATCH_DURATION_MS`. The same floor holds for a
  person (S-5): a `finished` result of a scraped event entered in Trading
  (`POST /admin/trading/events/:id/result`) before `kickoff + MIN_MATCH_DURATION_MS` is refused with
  409 `match_not_over` (the details give the earliest moment); cancelling or postponing is never
  delayed.
- **R2 Agreement.** A result is confirmed only if at least
  `MIN_INDEPENDENT_SOURCES` distinct **upstreams** each have a current
  `finished` observation for the fixture, with `scoreBasis = regular_time`, and
  identical full-time scores. If the event `needsHalfTimeScore`, at least one of
  those observations must give the half-time score, and every observation that
  gives one must give the same (R3); an observation without a half time is
  silence on it, so a full-time-only upstream (The Odds API's scores) still
  counts for the full time. The half time then rests on the upstreams that give
  it: it settles only `ht_1x2`. Sources that share an upstream count once.
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
- **R12 Overdue.** An event of an enabled competition that is still scheduled and unresulted
  `MIN_MATCH_DURATION_MS + UNVERIFIED_AFTER_MS` after kickoff (7 h 45 min), with no open result item about
  it (`result_ready`, `result_unverified`, `result_conflict`, `result_correction`, `score_basis_unknown`,
  `cancellation_proposed`), opens `result_overdue` with the event's exposure (R9). The gates only speak about
  a score they have seen, so without this a match no source has a score for was silent forever. A person
  looks the score up on an official site and enters it in Trading. Dismissing the item silences it for
  24 hours. It closes by itself when the event has a result, its kickoff moved later or another result item
  opens. It applies, cancels and voids nothing.

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
  observing and raising review items go on (shadow mode). One exception, because it only
  reduces exposure: K1 still closes betting on an earlier-kickoff report while the
  competition policy is off; K2 does not depend on the policy.
- **S5 Stale.** A source can answer every run with a page that never changes, and
  every other signal says "ok". An enabled source whose latest run was `ok` is
  stale when a match it lists (a current fixture observation of the source for the
  event's competition and teams) is still scheduled and unresulted, ended (at the
  earliest, kickoff + `MIN_MATCH_DURATION_MS`) `SOURCE_STALE_AFTER_MS` (48 h) ago or
  more, and nothing the source shows has changed since that end (`changed_at` of its
  observations). `source_stale` opens for the source with the hours unchanged and the
  matches waiting; a source that is quiet between match days is not stale, because
  the clock starts when a listed match ends. Dismissing it silences it for 24
  hours. It closes by itself when the source shows something new, when no listed
  match is waiting, or when the source is disabled or failing (those have their own
  signals). It changes no data.

### 6.4 Names and time

- **N1 Normalisation.** NFKC → lower-case → strip diacritics → `&` to `and` →
  drop punctuation → collapse spaces → drop the tokens `fc cf sc afc bsc` at the
  start or end only.
- **N2 Exact only.** A raw name resolves only when its normalised form equals
  an alias (source-specific alias first, then global) or a catalogue name /
  short name of the sport. Never fuzzy. If it maps to more than one team it is
  ambiguous and unresolved.
- **N2a Aliases act on stored data.** Removing or changing an alias (or a
  catalogue name) changes what is already stored: the promotion pass re-resolves
  the current observations of the sport when the names/aliases changed, un-maps
  a name that no longer resolves (its `unknown_team` / `unknown_competition` item
  opens) and re-maps one that now points elsewhere; a fetch writes the resolution
  it computed, null included.
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
- **O1m Market backing (2026-11, R-1 of `docs/feed-quality-plan.md`).** Opening betting (F7b, a
  trader's "Open betting" and the Trading switch) needs O1 **or** O1m. O1m: its competition's policy
  takes market prices, the event's stored prices
  come from the market (its pricing stamp is a market key, O5) and the fresh 1X2 consensus behind them
  (`MARKET_ODDS_MAX_AGE_MS`, one voice per upstream and bookmaker) has at least
  `MARKET_OPEN_MIN_BOOKS` (3) distinct bookmakers, one of them in `SHARP_BOOKMAKERS` (pinnacle, the
  Betfair exchanges, smarkets, matchbook): `marketBacksOpening`. F7b also requires the market to price
  the event now with exactly the stored prices (`backedByMarket`: same key, so nothing is held or
  skipped in between). The hand-over of a `ratings_uncalibrated` item (O5) applies the same test, so a
  trader is never asked to open what would be refused. Model-priced events keep O1. The audit of
  `scrape.fixture.betting_opened` records `calibration`: `ratings` or `market`.
- **O2 Sane prices.** Prices come from `priceMatch(matchStrengths(...))`. Before
  a market is stored or opened: every price is a valid odds value; where the
  selections partition the outcomes, the overround lies in
  `[OVERROUND_MIN, OVERROUND_MAX]`. Each market is priced as one book
  (`priceBook`, `packages/feed/src/pricing/book.ts`): the margin (6%, correct
  score 15%) is spread over the whole book in proportion to the probabilities,
  and the prices are rounded to the hundredth so the total comes out within a
  rounding step of it (under 0.2 percentage points on every market of the odds
  evaluation grid, 0 of 6561 books and of 380 real fixtures outside
  +-0.5 pp, where before a lopsided over/under, double chance or 1X2 book came out
  down to 6 pp thin). A heavy favourite is still priced at 1.01 (1.001 above
  p = 0.990) and the longshot opposite carries what it cannot; every price stays
  at or below its fair price.
- **O1 and O2 when a person opens betting.** Both controls that open betting on an event the scraper
  created (the review item's "Open betting", `POST /admin/feed/review/:id/resolve`, and the betting switch
  in Trading, `POST /admin/trading/events/:id/betting`) apply O1 (or O1m) and O2 again at that moment, on the stored
  prices of the open and suspended markets: 422 `teams_uncalibrated` or `prices_failed_checks`, and a review
  item stays open. Before O1 and O2 the same two controls apply K2 (6.1a): the kickoff must be confirmed
  (C1, C2 or a person's confirmation, C3) and start later than `now + MIN_LEAD_MS`. Closing betting is never
  refused; events of any other feed are not affected.
- **O3 Re-pricing.** After ratings change, scheduled events are re-priced only if
  no selection of the 1X2 or the 2.5 goals line moves by more than `MAX_PRICE_MOVE_RATIO` in
  either direction (`PRICE_MOVE_LIMITED_MARKETS`; the other markets follow them and their own
  moves do not hold the event, but no market may disappear, every market keeps its selections, and
  O2 applies to every market); otherwise the old prices stay and `odds_approval` opens with the
  proposal. A market the stored book does not have may be added (it has no price to move from and
  O2 checks it): a market type offered since the event was priced, such as the handicaps (2026-11),
  reaches existing events at their next re-price without holding them.
  How it is done (`repriceScheduledEvents`, the last step of the promotion pass):
  `scrape_event_pricing` stamps, per event, a fingerprint of both teams' ratings
  (`ratingsKey`) that the stored prices were computed from, set when the event
  is created and on every re-price. An event whose teams' current fingerprint
  differs is priced again (`priceFixture`) and checked with `checkReprice`
  against its stored open and suspended markets (a closed market keeps its
  price). Accepted: applied with `upsertFixture` in one transaction (only open
  selections whose feed price moved change, so a trader's price stays until the
  model itself moves), stamp and audit `scrape.fixture.repriced` in the same
  transaction, deltas published after COMMIT. Refused: nothing changes and the
  item `odds_approval` with subject `<feedRef>|reprice` carries the proposal and
  the fingerprint; the held fingerprint is remembered, so the same ratings are
  not raised again (even if the item is dismissed). Never re-priced: events that
  are not `scheduled`, are resulted, start within `MIN_LEAD_MS`, whose
  competition has no policy row, or whose teams are not calibrated (O1). A
  competition whose policy is not `enabled` is not re-priced by itself either
  (S4): the proposal is held as the same item (reason `policy_disabled`) and
  switching the policy on looks at the event anew. Betting stays as it is (a
  closed event is re-priced and stays closed) and bets already placed keep the
  odds they were accepted at (a bet leg stores them). A trader applies a held
  proposal with the decision `apply_reprice` (`trading.odds`): the server uses the
  proposal stored in the item (never a price from the request), refuses it when
  the ratings changed since (409 `proposal_stale`), the event is not scheduled
  or starts within `MIN_LEAD_MS`, or the book no longer fits the event's markets
  or fails O2 (422 `proposal_not_applicable`), and applies it in one
  transaction like the automatic path; only the size of the move is waived.
- **O5 Pricing source (bookmaker odds first, model as fallback).** Where an event's prices come
  from is decided by one function (`priceEvent`, `apps/scraper/src/pipeline/event-pricing.ts`),
  used by creation, re-pricing and the hand-over to a trader. For a competition whose policy
  `pricing_source` is `market`, an event that already exists is priced from the licensed feed
  when ALL of these hold: the 1X2 consensus (`marketConsensus`: per bookmaker, the margin
  removed proportionally, then the median) comes from at least `CONSENSUS_MIN_BOOKS` (2)
  complete, sane books, counted once per (upstream, bookmaker); every price used was last
  listed at most `MARKET_ODDS_MAX_AGE_MS` (3 hours) ago (see 3.1); the consensus has an
  over/under line to fit the goals to: 2.5, or when 2.5 has none the x.5 line from 1.5 to 4.5
  with the most books (then the nearest to 2.5, then the lower), because fitted to the 1X2 alone
  the goals model prices over 2.5 five to nine points short (`docs/theoddsapi-plan/README.md`,
  10.3); and the goals model fitted to the 1X2 and that line (`fitGoalsToMarket`) explains them,
  with a fit residual of at most `MAX_MARKET_FIT_RESIDUAL` (0.03). Then the 1X2, double chance and draw no bet are priced from
  the consensus probabilities, the 2.5 goals line too when the consensus has it, and every other
  market from the goals model fitted to it (`priceFootballFromMarket`), all with our own margin
  and O2. The stamp key is `marketPricingKey` (prefix `mkt1`, probabilities rounded to half a
  percentage point, so a market that only wiggles does not re-price), and the event counts as
  calibrated for re-pricing: O1 is about team ratings and market prices do not use them (opening
  betting without calibrated ratings needs O1m). In every other case
  (policy `model`, no event yet, fewer books, stale, no over/under line, poor fit) the prices are
  the model's, with
  `ratingsKey` and O1, exactly as in O3.
  - A **new** event is always created with the model's prices; the next re-pricing pass moves it
    to the market prices.
  - Re-pricing is O3 with the other key: an event whose stamp differs from the key it would get
    now is priced again, checked with `checkReprice` (including the switch from model to market,
    which is a big move if the two disagree: it is held as the `odds_approval` item
    `<feedRef>|reprice` for a trader, unless A1 waives the bound for a first market price), O2 on
    every market, and applied only inside the bounds.
    It looks at market-policy events whose teams are not calibrated too. It never opens betting,
    never touches an event within `MIN_LEAD_MS`, not scheduled or resulted, and a competition
    whose policy is not `enabled` only gets held proposals (S4).
  - A market-priced event whose market is no longer usable **keeps its prices**: it does not fall
    back to the model by itself (a person switches the competition back to `model` if wanted).
    Within `MARKET_LAPSE_LEAD_MS` of kickoff its markets are suspended until a fresh market prices
    it again (A2); a `market_stale` alarm opens within 24 h, whatever the reason (P-7).
  - An event priced from the market whose teams are not calibrated is handed to a trader's "Open
    betting" item only when O1m holds (3 distinct books, one sharp); with auto_open on, F7b then
    opens it once the kickoff is confirmed (K2). Re-pricing itself never opens betting.
  - The `odds_approval` payload says where the prices came from (`pricing`: `source`, `books`,
    `residual`, or the `fallback` reason: `no_consensus`, `no_totals` or `poor_fit`); the audit
    of `scrape.fixture.repriced` and
    `scrape.fixture.calibrated` records the same. A trader applies a held market proposal with
    `apply_reprice` while it is the proposal the scraper last raised (else 409 `proposal_stale`).
  - Constants (`packages/scraper/src/constants.ts` and the pricing packages): `CONSENSUS_MIN_BOOKS` 2,
    `MARKET_ODDS_MAX_AGE_MS` 3 h, `MARKET_ODDS_LINK_WINDOW_MS` 6 h, `MAX_MARKET_FIT_RESIDUAL` 0.03,
    `MAX_PRICE_MOVE_RATIO` 1.25 (unchanged).
- **O4 Ratings update.** A confirmed result updates both teams' ratings once
  (`scrape_rating_applied`), in the same transaction as the result. In the same
  transaction the competition's home advantage is re-derived from its finished
  scraped results (`competitionGoalEvidence`: home goals, away goals, matches),
  blended with the default 1.15 by 800 pseudo-matches, kept in 1.05 to 1.35 and
  rounded to a hundredth (`learnedHomeAdvantage`), and written as `homeAdvantage` on
  both teams' ratings, only once the competition has 40 results and the value
  differs from the default. Pricing and the next update read it from the HOME
  team's ratings (`matchStrengths`, `updateFootballRatings`), so what is learned
  is what is priced; it is part of the ratings fingerprint, so a change goes
  through the O3 re-price like any other. Open bets keep their odds. Seasons
  of results that were only backfilled (`ratings backfill`) are not events and do
  not count as evidence. Evaluated out of sample (odds evaluation, F-07). A
  result a person entered by hand in Trading (S-5) moves the ratings too: the
  promotion pass (`rateHandResults`, before re-pricing) finds the scraped football
  events resulted `finished` with a score that kicked off in the last 7 days
  (`HAND_RESULT_RATING_WINDOW_MS`) and have no `scrape_rating_applied` row, oldest
  kickoff first, and applies the same update once (audit `scrape.result.rated`,
  `via: hand`). A later correction does not move the ratings again.
- **A2 Suspension while the prices cannot be trusted (2026-11, A-2 of `docs/feed-quality-plan.md`).**
  The last step of the re-pricing pass (`syncSuspensions`) decides, for every scheduled event of an
  enabled competition that starts after `now + MIN_LEAD_MS`, a cause, in this order:
  `reprice_held` (an O3 re-price waits for a person: the open `odds_approval` item
  `<feedRef>|reprice`, so the stored prices are not the current ones); `market_lapsed` (the stored
  prices came from the market, the competition still takes market prices, the event starts within
  `MARKET_LAPSE_LEAD_MS` (3 h) and the market cannot price it from prices listed in the last
  `MARKET_LAPSE_MAX_AGE_MS` (30 min): no consensus, no over/under line or a poor fit); or none. Only a
  change of cause acts, remembered in `scrape_event_pricing.suspended_for`: a new cause suspends every
  open market of the event (`suspendEvent` without an actor, so `suspended_by = 'feed'`; audit
  `scrape.fixture.suspended`), and no cause any more re-opens the markets the feed suspended
  (`resumeEvent` without an actor, never a trader's suspension; audit `scrape.fixture.resumed`). A
  trader who re-opens the markets in between is not overruled for the same cause. Prices, betting
  and review items are not touched; a trader's `apply_reprice` or a dismissed proposal re-opens the
  markets at the next pass (within a minute). An event within `MIN_LEAD_MS`, started, resulted or of a
  switched-off competition (S4) is left as it is: a suspension stays, and the result settles suspended
  markets like open ones.
- **A1 First market price (2026-11, A-1 of `docs/feed-quality-plan.md`).** The first switch of an event
  from the model's prices to the market's is applied whatever the size of the move (only
  `price_move_too_large` is waived: O2 and the market set still apply) when there is nothing real to
  compare with and nobody could have bet: the stored prices are the model's for teams whose ratings are
  not both calibrated (O1 fails), the market backs opening (O1m: 3 distinct books, one sharp), betting
  is closed and no bet was ever placed on the event. Audit `scrape.fixture.repriced` with
  `boundWaived: 'A-1'`. A proposal held for such a switch earlier is looked at again while it is still
  open and applied the same way (resolution "the first market prices replaced the model's (A-1)"); a
  dismissed one is not. Calibrated teams keep the hold: a model that disagrees with the market by more
  than the bound is a question for a trader. (The plan said to create such events on market prices;
  they are created on the model and switched at the next pass, within a minute, with the same effect.)
- **Q1 Review queue sweeper.** Open review items that became pointless are closed by the
  scraper (`sweepReviewQueue`, the last step of the promotion pass). In scope: the requests to open
  betting (`odds_approval` on the event's `feed_ref`, F7, and `ratings_uncalibrated`) and the held
  re-prices (`odds_approval` on `<feedRef>|reprice`, O3); no other kind or subject is touched. The
  first reason that holds closes them, with the resolution `auto: <reason>` (resolved by the scraper,
  audit `scrape.review.swept` per item): `event_missing` (no scraped event with that `feed_ref`),
  `event_resulted` (`resulted_at` set), `event_started` (live, finished, or scheduled with a start
  time in the past), `event_cancelled` (cancelled or abandoned) and, for the requests only,
  `betting_open` (a held re-price stays open while betting is open: a trader still decides on it).
  A postponed event, or a scheduled one that has not started, keeps its items. Each subject is
  closed in one transaction that locks the event row, then its items, and checks the conditions
  again. Nothing else changes (no event, market, price, bet or `scrape_event_pricing`), and a second
  pass closes nothing.

### 6.6 Scraping manners

One identifying `User-Agent` with a contact; robots.txt enforced (licensed mode
refuses to turn it off); per-host minimum interval with jitter; conditional
requests; `Retry-After` honoured; response size and time limits; no login, no
CAPTCHA or bot-protection circumvention, no proxy rotation to evade blocks.
Each source's terms are checked by a person before it is enabled. A licensed
API's key is not a login: it is sent as in 6.7.

### 6.7 Source authentication (API keys)

A licensed API such as API-Football authenticates with a request header
(`x-apisports-key`). A `generic-json` config may carry one optional `auth` block:

```json
"auth": { "header": "x-apisports-key", "secret": "SCRAPER_SECRET_API_FOOTBALL" }
```

- `header` is a valid header name (token, at most 64 characters). It may not be `host`, `cookie`,
  `content-length`, `connection`, any hop-by-hop header (`keep-alive`, `proxy-authenticate`,
  `proxy-authorization`, `proxy-connection`, `te`, `trailer`, `transfer-encoding`, `upgrade`), or one the
  fetcher owns (`user-agent`, `authorization`, `if-none-match`, `if-modified-since`, `set-cookie`).
- `secret` is the **name** of an environment variable and must match `^SCRAPER_SECRET_[A-Z0-9_]{1,64}$`. The
  config (and so `scrape_sources.config`, the audit trail and every config error) never holds a value: a key
  pasted into the config is refused by the schema, and the refusal does not repeat it. There is one block and
  one header per source; the block applies to every request of that source (`generic-json` only).
- The adapter's plan carries only that reference (`FetchPlanItem.auth`). **The fetcher reads the value**
  when it fetches, from the reader it was given (`PoliteFetcher` option `secrets`; the app passes the process
  environment, tests pass a map). The value is trimmed; empty or unset is `secret_missing`, a value that is not
  printable ASCII is `secret_invalid`. Both are refusals **before any request** (robots.txt included) and
  before the circuit breaker is touched; the run fails with that issue code (fatal, naming the variable) and
  `dry-fetch` exits 1.
- The host allow-list, robots.txt (fetched without the key), the rate limit and the retries apply exactly as
  for any request. The key goes only to the **origin** (scheme, host and port) of the request URL: a redirect
  to any other origin, even one in `allowedHosts`, is followed without it.
- The value is kept out of everything we write: transport errors are redacted before they leave the fetcher;
  a response that contains the key is dropped (`secret_echoed`: not archived, not parsed); nothing logs
  request headers; the value is not in the config object, the context or the database. Tests search logs,
  run issues, every table, the archive and the CLI output for it.

## 7. Configuration

Added to `packages/config` (all optional unless noted; env names are
normative):

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

There is **no** setting for the number of sources a result needs: it is the
constant `MIN_INDEPENDENT_SOURCES = 2`.

`SCRAPER_SECRET_<NAME>` (any name matching `^SCRAPER_SECRET_[A-Z0-9_]{1,64}$`, none by default) holds the API key
of a source whose config names it in `auth.secret` (6.7). These are read by the fetcher, not by `packages/config`,
so they are not in the config object; the production compose file passes them to the `scraper` service only.

## 8. Back office

Routes under `/admin/feed/*`, contracts in `packages/contracts/src/feed.ts`, with
the same table-of-routes-and-permissions pattern as `COMPLIANCE_ROUTE_PERMISSIONS`.
Existing permissions are reused (no new ones):

| Route                                                                       | Permission                                                                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /admin/feed/health` (sources, last runs, queue counts)                 | `trading.view`                                                                                                                       |
| `GET /admin/feed/review`, `GET /admin/feed/review/:id`                      | `trading.view`                                                                                                                       |
| `POST /admin/feed/review/:id/resolve` – open betting, dismiss, map alias    | `trading.status`                                                                                                                     |
| … same route applying a **result** (`result_ready`, `result_unverified`)    | `trading.result`                                                                                                                     |
| `GET /admin/feed/aliases`, `POST` and `DELETE /admin/feed/aliases/:id`      | `trading.view` / `trading.status`                                                                                                    |
| `PUT /admin/feed/sources/:id` – enable or disable (kill switch)             | `trading.status`                                                                                                                     |
| `GET /admin/feed/competitions`, `PUT /admin/feed/competitions/:id` – policy | `trading.view` / `settings.edit` (turning a policy **off**, or setting `pricingSource` back to `model`, needs only `trading.status`) |

Every mutation is audited with the staff actor. Resolving a result applies it
through the same function as automatic promotion, so the rules R1, R8–R11 hold
for people too (a person may override R2/R6 only through `result_unverified` /
`result_ready`). Before it is applied the confirmation is
re-checked against the current observations (kickoff within tolerance, no
dissent on full time or on the half time an event needs, a half time present when
the event needs one); a failed check rejects it, audits
`scrape.result.confirmation_rejected` and opens a fresh item.

Every review item is written in the shape of `REVIEW_PAYLOAD_SCHEMAS` (`packages/contracts/src/feed.ts`): the
page reads an item only if its payload parses, and otherwise shows "could not be read" without an Apply, Map or
Open button. Result items carry the match (`gameId`, `home`, `away`, `kickoff`), the score and the sources behind
it as `{ sourceId, upstream, changedAt }`; dispute items carry the applied score and each source's observation as
a score object; unknown-name items carry the competition and suggestions as `{ id, name, score 0 to 1 }`;
`source_broken` carries `runId`, `reason`, `recordsAccepted` and `baseline`; the plain kinds carry a `detail`
sentence. `apps/scraper/test/review-contract.test.ts` checks every kind on items the real pipeline wrote.

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

## 12. Onboarding commands (`apps/scraper/src/cli.ts`)

No back-office screen creates sources, so onboarding uses a command line:

```
pnpm --filter @vamos/scraper-app cli <command> [options]
```

Results go to stdout (`--json` for machine-readable output), problems to
stderr. Exit code: `0` success, `1` the command failed or refused, `2` the
command line is wrong. Commands that need the database use `DATABASE_URL` from
`.env` and check the operating mode like the runner does.

| Command                                                                            | What it does                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources list`                                                                     | Every source with state: enabled or disabled, last run, failures since the last ok run, open review items.                                                                              |
| `sources upsert --file source.json`                                                | Checks the config with `createAdapter` (the runner's own check, so config errors such as a score without a status map are listed), then upserts.                                        |
| `dry-parse --source-file source.json --document page.html`                         | Parses a saved page; prints observations and issues. No database, no network. Options: `--url`, `--at`, `--content-type`, `--limit`.                                                    |
| `dry-fetch --source-file source.json`                                              | Fetches the planned URLs through the `PoliteFetcher` (allow-list, robots.txt, rate limit; the `auth` key from its `SCRAPER_SECRET_*` variable) and parses; prints only. Writes nothing. |
| `aliases import --file aliases.csv`                                                | Bulk team and competition aliases. Idempotent; one bad row stops the import and nothing is written.                                                                                     |
| `aliases list [--kind team\|competition] [--q text]`                               | Aliases newest first with their ids; `--q` matches the name or the target.                                                                                                              |
| `aliases remove --id <id>`                                                         | Removes one alias (audited). The next promotion pass re-resolves the observations that used it.                                                                                         |
| `ratings backfill --file results.json --competition <slug> [--dry-run]`            | Learns ratings from historical results; prints before and after per team.                                                                                                               |
| `ratings set --team <name> --attack <n> --defence <n> [--matches <n>] [--dry-run]` | Sets a team's ratings by hand, with `manual = 1`; prints before and after.                                                                                                              |
| `ratings list [--team text]`                                                       | Football teams that have ratings: attack, defence, matches, manual.                                                                                                                     |

`source.json` is `{ "id", "name", "adapter", "upstream", "config" }` (the
columns of `scrape_sources`; `enabled` is not allowed). **A new source starts
disabled**, and `sources upsert` never changes the flag of an existing one:
switching a source on is a person's decision, made after `dry-fetch` looks right
and the terms check is recorded (`docs/scraper-plan/07-*`). Exit code 1 and a
failed `dry-parse` or `dry-fetch` mean the config or the page needs work.

`aliases.csv` has a header with the columns `kind,sport,alias,target,source`
(any order, `source` optional): `kind` is `team` or `competition`, `sport` is
`football`, `alias` is the source's spelling (normalised on import), `target` is
the catalogue team's short name or the competition's slug, `source` is a source
id (empty or `*` = every source). An alias that already points at another team
or competition is reported as a conflict; remove the old alias first, on
`/feed/aliases` (the **Remove** button asks for a second click) or with
`aliases list --q <name>` and `aliases remove --id <id>`. Removing an alias
changes nothing at once: the promotion pass notices the change within a minute
and re-resolves the stored observations, which can open `unknown_team` items
for names that no longer resolve.

`results.json` is an array of `{ "date": "YYYY-MM-DD", "home", "away",
"homeGoals", "awayGoals" }` (regular-time scores, any order; team names are
catalogue short names or names). The backfill replays them oldest first with
every team starting neutral and stores `attack`, `defence`, `matches` (the
file's results for that team) and `backfilled_through` (the newest date,
`YYYYMMDD`). Running the same file again changes and audits nothing. The command
refuses, writing nothing for any team, when a team has `manual = 1`, has already
learned from more matches than the file holds (live results were applied since),
or was backfilled through a later date than the file reaches. `--dry-run`
reports all of this without writing, and exits 1 on a refusal too.

`ratings set` is for a team that has no season of history: a trader sets
`attack` and `defence` (multipliers of the league average: 1 is average, and a
higher defence concedes **more**) and the command writes them with `manual = 1`,
so the team counts as calibrated whatever its match count (rule O1) and a later
backfill leaves it alone. Both numbers must lie between 0.35 and 3, the band
the ratings model keeps every strength in. `--matches` (a whole number, default
what the team already has) is only informational for a manual team. Other keys
the team has, such as `backfilled_through`, are kept. The team name must match
exactly one football team (short name or any catalogue name, compared
normalised); an unknown or ambiguous name is refused and the command lists
similar names or the candidates. It prints the ratings before and after, writes
one `scrape.ratings.updated` audit row (`before` and `after`), and writes nothing
with `--dry-run` or when nothing would change. Prices of scheduled events change
on the next promotion pass, under rule O3. Football only.

### Production

The production stack does not publish Postgres, so the command line runs inside
the scraper image, on the compose network, with the service's own environment
(the restricted `vamos_app` role, the operating mode, `read_only` root, the
`node` user). `dist/cli.js` is in the image (`apps/scraper/tsup.config.ts` builds
it next to `dist/main.js`; the working directory is `/app/apps/scraper`). From
the checkout on the host, with `COMPOSE_FILE` and `COMPOSE_ENV_FILES` set as in
[deployment.md](deployment.md):

```
docker compose run --rm --no-deps scraper node dist/cli.js sources list
docker compose run --rm --no-deps -v "$PWD/source.json:/in/source.json:ro" \
  scraper node dist/cli.js sources upsert --file /in/source.json
```

- `--no-deps` starts nothing else: postgres must already be up (`docker compose up -d`). `--rm` removes the
  one-off container; it does not touch the running `scraper` service.
- Files the command reads (`source.json`, `aliases.csv`, `results.json`) are mounted read-only at `/in/...` and
  the path after `--file` is the path **inside** the container. The `node` user (uid 1000) must be able to read
  them (mode `0644`).
- `dry-fetch` fetches from inside the container, so it uses the production network path and `SCRAPER_*` settings.
- Output and exit codes are the same as in development; add `--json` for scripts. CI runs
  `sources list` this way after the smoke test, which proves the command line works in the image against the
  compose database.
