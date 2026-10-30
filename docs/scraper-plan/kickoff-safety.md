# Kickoff safety (fix-plan item F-01)

Status: **spec, not built**. Severity CRITICAL (`docs/scraper-evaluation/00-scorecard-and-fix-plan.md`, F-01).
Scope: the rules K1 to K6 below, the code and tests that enforce them, the operator wording. Nothing here
changes results, statuses, prices or bets. Constants live in `packages/scraper/src/constants.ts` like every
other scraper threshold; rule ids are cited in test names.

## 1. Problem and evidence

### 1.1 Mechanism

Prematch betting on an event closes by itself at `events.start_time` (`isSelectionBettable`,
`packages/db/src/catalog/live.ts`). Scraped events never go live. So the exposure is exactly this: **betting is
open and the real kickoff is earlier than our `start_time`**. Between the real kickoff and our start, people can
bet on a match in play at prematch prices.

Today:

- F2 creates the event at the source's kickoff; F7 opens it at once if the competition has `auto_open`, else a
  trader opens it from the `odds_approval` item, from 14 days ahead (`FIXTURE_HORIZON_MS`).
- With one source, a later correction to an earlier time goes through F4: it is never applied with one upstream,
  it opens a critical `kickoff_change`, and **betting stays open** until a person acts.
- F4b moves an event **later** on one source (shift at most 2 h, no bets) **while betting is open**. If that one
  source is wrong, betting stays open past the real kickoff. This is a second exposure path (rule K4 closes it).

### 1.2 Evaluation numbers (`01-data-accuracy.md` 3.1, 3.7, gap G2)

- Next 14 days at 2026-10-29: 20 Premier League fixtures, 12 exact, **8 wrong**, **2 start earlier** than our
  event (Everton v Coventry Fri 20:00 vs our Sat 15:00, 19 h earlier; Leeds v Tottenham 12:30 vs 15:00).
- 2026-27 season: 21 of 380 kickoffs wrong, all unplayed, all the Saturday 15:00 placeholder; openfootball HEAD
  was 37 days old. History: placeholders replaced 4 to 13 days before the match, inside the 14-day horizon.

### 1.3 Replay measurement (this spec)

**Method.** Every commit of openfootball `en.1.json` (2025-26: 22 commits, 20 usable after dropping the
invalid-JSON and the no-dates commit, which S1 would reject; 2026-27: 8 commits) was replayed as the state of a
single source over time: at time t the source says what the latest usable commit before t says. Truth is the FPL
`kickoff_time` (380/380 equal to openfootball's final 2025-26 file). Per match: the event is created at the first
moment the listed kickoff is inside `(t + MIN_LEAD_MS, t + 14 d]`; F4b moves applied as today (none occurred);
no trader action on items. **Worst case on opening:** without a rule, betting opens at creation (auto open, or a
trader at once). "Exposed" = open at the real kickoff while our start is later (hours = start minus real kickoff).
2026-27 truth is used up to 30 Nov only (FPL carries TV picks to round 12); 30 Oct to 30 Nov is a projection with
the source frozen as it is. Assumption: records with `score: {}` are read as unplayed (fix G4); the adapter of the
time dropped them, which only delays creation. The scripts were design tools and are not committed; section 7.4 specifies
the committed replay test that reproduces these numbers.

Candidate rules (single source, so C1 below never applies). "Fresh" and "lead"/"stable" are defined in section 2.

| Rule                                                | Played: events open at a wrong kickoff | Played: exposed (hours) | Correct events never openable by the source alone | Median open hours before kickoff, correct events (25-26 / 26-27) | Projection 30 Oct-30 Nov: exposed (hours) |
| --------------------------------------------------- | -------------------------------------- | ----------------------- | ------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| A today (open at creation, no K1)                   | 41 of 313                              | **14 (440.0 h)**        | 0 of 272                                          | 336 / 336                                                        | 4 (43.0 h)                                |
| B K1 only                                           | 41                                     | 6 (312.0 h)             | 0                                                 | 336 / 336                                                        | 4 (43.0 h)                                |
| C K1 + block Saturday 15:00 (default slot)          | 12                                     | 4 (242.5 h)             | 76                                                | 336 / 336                                                        | 0                                         |
| D K1 + fresh source                                 | 25                                     | 3 (38.5 h)              | 48                                                | 251 / 336                                                        | 0                                         |
| E K1 + lead 72 h                                    | 11                                     | 4 (105.5 h)             | 0                                                 | 72 / 72                                                          | 4 (43.0 h)                                |
| J K1 + lead 72 h + stable 24 h + fresh              | 0                                      | 0                       | 129                                               | 6.9 / 27.9                                                       | 0                                         |
| L same, lead 5 d                                    | 1                                      | 0                       | 120                                               | 33.1 / 76.7                                                      | 0                                         |
| M same, lead 7 d                                    | 11                                     | 2 (36.0 h)              | 94                                                | 74.7 / 168                                                       | 0                                         |
| **Q = J + freshness must be known (chosen, K1+K2)** | **0**                                  | **0**                   | **131 (48%)**                                     | **0.0 / 7.8**                                                    | **0**                                     |

Per season, rule A: 2025-26 238 events, 27 wrong at creation, 10 exposed (397.0 h, largest 116.5 h: Brighton v
Chelsea listed Sun 26 Apr, played Tue 21 Apr); 2026-27 to 29 Oct 75 events, 14 wrong, 4 exposed (43.0 h).
Rule Q: 2025-26 105 opened, 0 wrong; 2026-27 36 opened, 0 wrong; projection 0 of 19 correct opened (source stale
since 12 Oct). Lead 96 h gives the same result as 72 h; 5 d already opens one event at a wrong time.

Findings that shape the rules:

1. **K1 alone is right but not enough.** All 8 K1 closures were real earlier kickoffs (precision 8/8), each 104
   to 288 h before the real kickoff. It removes 8 of 14 exposures; the other 6 were never corrected by the source
   before the match.
2. **Default-slot detection is the wrong tool.** The uncorrected 2025-26 cases were midweek re-arrangements of
   Sunday 13:00/14:00/15:30 slots, not Saturday 15:00. Blocking the slot leaves 4 exposures (242.5 h) and keeps 76
   correct events closed. It would also need a per-league local slot table and time zone (G7). Rejected in favour
   of a generic rule.
3. **Source freshness is the deciding factor.** Every uncorrected exposure happened while the source had stopped
   updating. Lead and stability without freshness leave 4 exposures (the frozen 2026-27 file is "stable" and wrong).
   The source was not stale (S5 sense) in only 26.0% of in-season hours in 2025-26 and 59.0% in 2026-27 (to 29 Oct).
4. **Stability 24 h adds no measured benefit** on this data (commits are days apart) and costs 3 events; kept as
   cheap insurance against a source in the middle of an edit, which this data cannot show.
5. **Freshness must be known.** A source whose listed matches have not ended yet cannot be judged; treating it as
   fresh is how a frozen file passed in August 2025 (Chelsea v Fulham, 2.5 h, rule D). Cost: 2 events.

Precision/recall of the opening decision, played period: rule A opens 313 events, of which 86.9% are never open
at a wrong kickoff, and protects 0 of the 41 wrong ones; rule Q opens 141, 100% right, and keeps all 41 wrong ones closed while wrong.
The price is that 48% of correct events cannot be opened on this one volunteer source without a person (C3) or a
second upstream (C1).

### 1.4 Found while reading the code (must be fixed with this item)

- **`apply_kickoff` cannot work on real F4 items.** The gate's `kickoff_change` payload (`decideExisting`, field
  names `eventStart`, `upstreams`) does not match the contract (`packages/contracts/src/feed.ts`
  `kickoff_change`: `currentKickoff`, `sources: SourceVote[]`). Checked: an F4 hold built with the gate testkit
  gives `parseReviewPayload('kickoff_change', payload) === null`, so the route answers 422 `invalid_payload`. The
  API tests only pass because they seed hand-written payloads. This is the trader's main tool after K1.
- **Stale rows of keyless sources.** openfootball has no external ids; a date change creates a new observation and
  leaves the old one "current" for ever (known-limits). The definition of _statement_ below excludes such rows.

## 2. Definitions

- **Listed row.** A row of `scrape_observations` of an enabled source with `last_seen_at` at or after the
  `started_at` of that source's most recent run with status `ok`: what the source said at its latest successful
  read (a 304 sighting counts, rule S1a). Rows a source no longer lists, including the old-day row a keyless
  source leaves when a match moves to another day, are not listed rows.
- **Statement about an event E.** A listed row with E's `competition_id`, `home_team_id` and `away_team_id`, and a
  kickoff at most `KICKOFF_EVIDENCE_WINDOW_MS` before or after `E.start_time`.
- **Agreeing statement.** A fixture statement with status `scheduled` whose kickoff is within
  `KICKOFF_TOLERANCE_MS` of the start.
- **Dissenting statement.** Any other statement: a scheduled fixture more than the tolerance away; a fixture
  `postponed` or `cancelled`; any result statement (before kickoff, a result about this pairing contradicts it).
- **Earlier-kickoff statement.** A fixture statement `scheduled`, or a result statement `finished`, whose kickoff
  lies in `[start − KICKOFF_EVIDENCE_WINDOW_MS, start − KICKOFF_TOLERANCE_MS)`; the kickoff may be in the past.
  Postponed, cancelled and abandoned statements are never earlier-kickoff statements (rule K5).
- **Healthy source.** Its latest finished run (status not `running` or `skipped`) is `ok`.
- **Fresh source.** Healthy, and both of these, computed over all the source's listed rows (any competition):
  - _known_: a listed row has `kickoff + MIN_MATCH_DURATION_MS + SOURCE_STALE_AFTER_MS ≤ now`. A source with
    nothing ended yet cannot be judged and is not fresh;
  - _not stale_: no listed fixture row with status `scheduled` has an earliest end `e` (its kickoff plus
    `MIN_MATCH_DURATION_MS`) with `e + SOURCE_STALE_AFTER_MS ≤ now` and `e > lastChangedAt`, where
    `lastChangedAt` is the largest `changed_at` of all the source's observations. This is S5 computed on the
    source's own rows; it does **not** read the `source_stale` item (a dismissed item must not make a source
    fresh) nor S5's event list (an event a trader resulted by hand must not hide a frozen source).
- **Independent upstreams.** As F2/R2: `countIndependent` over the statements' `upstream` (trimmed, lower-cased);
  sources sharing an upstream count once. Independence is what the operator declared in `scrape_sources.upstream`.
- **Person confirmation (record).** The latest audit row `scrape.fixture.kickoff_confirmed` for the event:
  `{ startTime, confirmedAt, evidenceKey }`, written by the API when a trader opens betting with "kickoff checked".
  A statement is _acknowledged_ when such a record exists with `startTime = E.start_time` (exact ms) and
  `statement.changed_at ≤ confirmedAt`. A record for another start time is ignored, so any kickoff move voids it.
- **Confirmed kickoff.** E is confirmed at `now` when one of:
  - **C1 two upstreams:** no dissenting statement, and agreeing statements of fresh sources from at least
    `MIN_INDEPENDENT_SOURCES` independent upstreams;
  - **C2 close and stable:** no dissenting statement, `now ≥ start − KICKOFF_CONFIRM_LEAD_MS`, and an agreeing
    statement of a fresh source with `changed_at ≤ now − KICKOFF_STABLE_MS` (`changed_at` moves on any payload
    change, so this can only under-state stability);
  - **C3 person:** a person confirmation record for this start, and every dissenting statement is acknowledged.
- **Evidence key.** SHA-256 hex of the canonical JSON array `[startISO, statements]`, the statements sorted by
  source id, kind and kickoff, each written as `[sourceId, kind, status, kickoffISO, changedAtISO]`. It identifies
  exactly what a person was shown.
- **Default slot.** Not used. Section 1.3 finding 2: a slot rule misses the measured mid-week re-arrangements,
  costs more, and depends on local time. The generic rule (C2 with freshness) covers placeholders because a
  placeholder is either corrected by a fresh source before the lead window or the source is not fresh.

New constants (`packages/scraper/src/constants.ts`, section "Kickoff safety"):

| Constant                     | Value  | Used by    | Why                                                                         |
| ---------------------------- | ------ | ---------- | --------------------------------------------------------------------------- |
| `KICKOFF_CONFIRM_LEAD_MS`    | 72 h   | C2         | 0 wrong opens at 72 h and 96 h; 1 at 5 d, 11 at 7 d (section 1.3)           |
| `KICKOFF_STABLE_MS`          | 24 h   | C2         | Insurance against a source mid-edit; measured cost 3 of 272 events          |
| `KICKOFF_EVIDENCE_WINDOW_MS` | 7 days | statements | Largest measured early move 4.9 days; a pairing never repeats within 7 days |

Reused: `KICKOFF_TOLERANCE_MS` (5 min), `MIN_INDEPENDENT_SOURCES` (2), `SOURCE_STALE_AFTER_MS` (48 h),
`MIN_MATCH_DURATION_MS` (105 min), `MIN_LEAD_MS` (10 min).

## 3. Rules

- **K1 Earlier kickoff closes betting.** For a scraped event (`feed_provider = 'scraped'`) that is `scheduled`,
  not resulted, `betting_open = true` and `start_time > now`: if it has an earlier-kickoff statement that is not
  acknowledged, the scraper, in one transaction under the event's row lock, re-reads the event and the evidence,
  and if the condition still holds:
  - sets `events.betting_open = false` with `setEventBettingOpen(tx, eventId, false)` (no actor: automatic). Only
    this flag changes. Markets, selections, prices, `start_time`, `status` and bets are not touched; bets already
    placed stand. Event-level closing is chosen over market suspension because it has exactly two re-open paths,
    both guarded by K2, while `resumeEvent` without an actor re-opens feed-suspended markets;
  - writes audit `scrape.fixture.betting_closed` (actor `system:scraper`, target the event) with metadata
    `feedRef`, `rule: 'K1'`, `start`, `earlier` (each `sourceId`, `upstream`, `kickoff`, `changedAt`) and
    `evidenceKey`;
  - opens or refreshes the review item `kickoff_change`, subject `<feedRef>|earlier`, severity `critical` (a
    separate subject, so the F4 gate, which rewrites the `<feedRef>` item every pass, cannot overwrite it). Its
    payload satisfies the contract (`eventId`, `currentKickoff` = start, `proposedKickoff` = the earliest earlier
    kickoff, `sources`, `hasBets`) plus `rule: 'K1'`, `reason: 'earlier_kickoff'`, `bettingClosedAt`,
    `statements`, `evidenceKey` and `exposure` (`getEventExposure`, R9);
  - after COMMIT publishes the `match` delta the service returned (`b: false`); clients grey out the event's
    selections and placement answers `suspended` (`unavailableReason`).

  K1 runs whatever the confirmation basis (a C1 event whose second source moves earlier is closed too). It acts
  only on open betting: on a closed event F4's critical item already informs and K2 keeps it closed. The F4
  `kickoff_change` items stay as they are.

- **K2 No opening on an unconfirmed kickoff.** Betting on a scraped event is opened only if its kickoff is
  confirmed (C1, C2 or C3) at that moment and it starts later than `now + MIN_LEAD_MS`. This holds on every path:
  - **F7 automatic opening** (`decideNew`): `openBetting` also needs the new gate input `kickoffConfirmed`. If
    `auto_open`, calibration and prices pass but the kickoff is not confirmed, the event is created closed with an
    `odds_approval` item, reason `kickoff_unconfirmed`. The pipeline computes `kickoffConfirmed` with the same pure
    function as everywhere (start = the kickoff being created, statements = the cluster's observations filtered by
    the definitions of section 2, no person record).
  - **Review item "Open betting"** (`POST /admin/feed/review/:id/resolve`, `open_betting`) and **Trading switch**
    (`POST /admin/trading/events/:id/betting`, `open: true`): `assertScrapedEventMayOpen` checks K2 under the row
    lock it already takes, before O1 and O2. Refusals: 422 `kickoff_too_close` (Trading switch now too, for
    scraped events), 422 `kickoff_unconfirmed` with details `{ startTime, evidenceKey, reasons, statements }`.
  - **Person confirmation (C3).** Both requests take an optional `kickoffChecked: { startTime, evidenceKey }`.
    When K2 would refuse, the server checks `startTime` = the event's start (else 409 `kickoff_changed`) and the
    evidence key recomputed under the lock = the one sent (else 409 `kickoff_evidence_changed`: something changed
    since the person looked), writes the record (audit `scrape.fixture.kickoff_confirmed`, actor the staff member,
    `{ startTime, evidenceKey, via: 'review' | 'trading', itemId? }`, `confirmedAt` = the audit row's time) in the
    same transaction, and continues with O1 and O2. If O1 or O2 refuse, the transaction rolls back and no record
    remains. A person can only confirm what the server showed them.
  - Closing betting is never checked. Events of any other feed are not affected (the guard returns early, as
    today).

  Reasons in `kickoff_unconfirmed` (all that apply, sorted): `no_statement` (no statement at all),
  `earlier_kickoff_reported` / `sources_disagree` (a scheduled statement earlier / later than the start),
  `void_status_reported` (postponed or cancelled), `result_reported` (a result statement), `source_not_fresh` (no
  agreeing statement from a fresh source), `too_early_for_single_source` (C1 not met and the lead window of
  `KICKOFF_CONFIRM_LEAD_MS` not reached), `not_stable` (no fresh agreeing statement unchanged for
  `KICKOFF_STABLE_MS`).
  Acknowledged dissent (C3) is not listed.

- **K3 Confirmation never opens betting.** Confirmation is computed when someone tries to open (and by F7 at
  creation); it is not stored. When a kickoff becomes confirmed later (a second source agrees, the lead window
  starts, the source becomes fresh), nothing happens by itself: the event stays closed and a trader opens it from
  the `odds_approval` item or Trading. `auto_open` stays creation-only (F7). A confirmation does not survive a
  kickoff move: the C3 record names the old start, and C1/C2 are re-evaluated against the new one.

- **K4 Later kickoffs.** F4 is kept, with one tightening: **F4b** (one source, later, at most `SMALL_SHIFT_MS`, no
  bets) also requires **betting closed**; with betting open it becomes `kickoff_change` reason `betting_open`
  (severity warning). `applyKickoff` re-checks `betting_open = false` for F4b under the row lock (it already
  re-checks start and bets). Rationale: if the later time is wrong, moving it keeps betting open into the match;
  not moving it closes betting early, which costs turnover, not money. F4a (two independent upstreams agree)
  still applies with betting open; the new start is then normally C1-confirmed.

- **K5 Void statuses stay with a person.** Postponed, cancelled and abandoned statements never trigger K1, never
  change a status and never void anything (F6, R7 unchanged: `cancellation_proposed`). Their only effect here is
  to make the kickoff unconfirmed (dissent), so betting cannot be opened without a person.

- **K6 Idempotent and race-safe.** The K1 pass changes something only when `betting_open` is true, so a second
  pass with the same data changes nothing (no audit, no item refresh). The scraper and the API both take the
  event row lock (`lockEvent`, `FOR UPDATE`) and re-read event, statements and person record inside the
  transaction before deciding. A trader's open-with-confirmation and K1 serialize: if K1 commits first, the
  trader's evidence key no longer matches (409) or matches and acknowledges exactly what K1 saw; if the trader
  commits first, K1 sees the acknowledgement. An observation stored by a fetch after K1 read it is handled by the
  next pass: the window is at most `PROMOTE_INTERVAL_MS` (60 s) after the observation is stored.

## 4. Fail-closed argument

| Rule | Automatic action                                         | Worst case if the rule is wrong                                                                                                                                      | Why exposure can only go down                                                                                                 |
| ---- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| K1   | `betting_open: true → false`, audit, review item         | A wrong earlier report closes betting on a correct event: lost turnover until a trader re-opens with C3. Measured: 0 of 8 closures wrong                             | Closing removes bettable selections; nothing else changes. It cannot open, move, price, result, cancel or void                |
| K2   | Refuses an opening (gate input; API 422/409)             | A correct kickoff is held closed (measured: 131 of 272 on one stale source) until a second upstream, the lead window, or a person                                    | It only removes openings; the set of open events under K2 is a subset of today's                                              |
| K3   | None                                                     | None (nothing automatic)                                                                                                                                             | No action exists                                                                                                              |
| K4   | F4b no longer applied while betting is open              | An event keeps an earlier start than the real one: betting closes early; a result arriving at the later time opens `result_conflict` (kickoff mismatch) for a person | Fewer automatic moves; the remaining start is never later than before                                                         |
| K5   | None                                                     | None                                                                                                                                                                 | Void statuses only add dissent (more refusals)                                                                                |
| C2   | Lets a person or F7 open on one fresh source within 72 h | A fresh source with a consistently wrong clock (wrong `timeZone`, G7) is trusted: up to its offset of exposure                                                       | Same exposure as today for that event but in a 72 h window instead of 14 days; listed as a residual risk in `known-limits.md` |

**Inside the CLAUDE.md scraper rule.** The new automatic code path (K1) writes one column, `events.betting_open`,
always to `false`, plus an audit row and a review item. It never calls `resultEvent`, never sets `events.status`,
never voids a market or selection, never moves `start_time`. Scraped data still reaches `resultEvent` only through
the result gates. K2 is a refusal. The licensed-mode guard and `OPERATING_MODE` are not touched.

**What keeps it there (tests, section 7):**

- static test `apps/scraper/test/kickoff-safety-static.test.ts`: the K1 module imports from `@vamos/db` only an
  allow-list (`lockEvent`, `setEventBettingOpen`, `getEventExposure`, `loadKickoffEvidence`, plus types); its
  text contains none of `resultEvent`, `voidMarket`, `voidSelection`, `setMarketStatus`, `suspendEvent`,
  `resumeEvent`, `applyLiveState`, `upsertFixture`, `setSelectionOdds`, nor a direct drizzle
  `.update(`, `.insert(` or `.delete(`; other imports come from `./common` (`openGateReviews`, `auditScraper`) and
  `@vamos/scraper`; every `setEventBettingOpen(` call has the literal `false` as third argument;
- the pure function's result type has no "open" action: K1's decision is `'none' | 'close'`, `'close'` requires
  `bettingOpen` (property P1);
- integration test: a row snapshot of `events` (all columns but `betting_open`, `state_changed_at`,
  `updated_at`), `markets`, `selections`, `bets`, `bet_legs` before and after a K1 pass is identical;
- `faults.test.ts`-style assertion extended: after every fault, no event was opened by the scraper.

## 5. Interplay and edge cases

- **Several clusters for one event (review finding 1).** K1 and K2 work per event over statements selected by
  pairing and window, not per cluster, so a split fixture gives one decision. `holdSeveralClusters` stays as is.
- **`feed_ref` moves.** The rules key on `eventId`; the item subject uses the immutable `feed_ref`
  (`<feedRef>|earlier`). A start moved by a trader beyond the window leaves old statements outside it.
- **Time zones and DST.** Statements carry UTC instants (rule T1); the rules compare instants only, so DST cannot
  affect them. Residual risk: a source configured with the wrong zone (G7: one zone per source, a multi-league
  file) shifts all its kickoffs by 1 to 2 h. Earlier shifts trigger K1 loudly; later shifts pass C2 with one
  source. Mitigation is operational (zone review per source before enabling; shadow comparison), recorded in
  `known-limits.md`.
- **Sources that disappear or go stale.** Disabled source: its rows are not statements (kill switch), so it neither
  confirms nor triggers K1. Failing source: its last successful statements still trigger K1, but it is not
  healthy, so it confirms nothing. Content-stale source (S5 sense): not fresh, confirms nothing. A source that
  drops the match: no statement, nothing confirms; open betting stays open (absence is not evidence of an earlier
  kickoff; F5's `fixture_missing` covers it).
- **Two sources disagree.** Dissent: no C1/C2; K1 if either is earlier; F4/F4c items as today.
- **Kickoff already in the past.** Event start passed: K1 skips it (prematch betting already closed by
  `isSelectionBettable`). Earlier statement in the past while our start is ahead (the match was played): K1
  closes; `apply_kickoff` refuses (too close), the trader leaves betting closed and results the match as usual.
- **Minimum lead.** K1 has no lead limit (closing is always allowed). Opening needs `start > now + MIN_LEAD_MS` on
  both API paths (the Trading switch gains this check for scraped events).
- **Demo seed and tests that create events directly.** K1/K2 apply only to `feed_provider = 'scraped'`. Demo
  seed events (mock feed) are untouched. `apps/scraper/src/devtools/seed-result-demo.ts` calls `decideFixture`
  with `auto_open`; its one-match source can never be "known", so it passes `kickoffConfirmed: true` with a
  comment (demo-only code, refuses outside `OPERATING_MODE=demo`). `seed-review-queue.ts` needs no change: the
  person opening its `odds_approval` event in the demo sees the new confirmation step. API tests that open a
  directly created scraped event send `kickoffChecked` (helper, section 7.3). Gate tests default the new input to
  `true`.
- **Re-pricing (O3).** Independent: re-pricing never changes `betting_open`; K rules never change prices.
  `apps/scraper/src/pipeline/reprice.ts` needs no change.
- **Policy switched off (S4).** K1 still closes (open decision 1); K2 does not depend on the policy.
- **Concurrency with a trader.** See K6. A trader closing betting makes K1 a no-op. A trader suspending markets is
  independent of the event flag.
- **Pending bets.** Prematch bets are accepted at once (`pending_acceptance` is live-only), so nothing is in
  flight when K1 closes.

## 6. Change list and order of work

No migration. Review kind `kickoff_change` reused; reason codes are payload text. Audit actions are new strings.

| Area         | File                                                                                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Constants    | `packages/scraper/src/constants.ts`                                                            | the three constants of section 2                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Pure rules   | `packages/scraper/src/gates/kickoff.ts` (new), `gates/index.ts`                                | types `KickoffStatement { sourceId, upstream, kind, status, kickoff, changedAt, sourceFresh }`, `KickoffPersonRecord`; `assessKickoff({ start, now, statements, person }) → { confirmed, basis: 'C1'\|'C2'\|'C3'\|null, reasons, earlier, evidenceKey }`; `earlierKickoffAction(event, assessment, now) → 'none'\|'close'`                                                                                                                                    |
| Fixture gate | `packages/scraper/src/gates/fixture.ts`                                                        | `FixtureGateInput.kickoffConfirmed: boolean` (required); `decideNew` uses it (reason `kickoff_unconfirmed`); F4b needs `event.bettingOpen === false` (reason `betting_open`); proposal payload adds `currentKickoff` and `sources` (`{ sourceId, upstream, changedAt }`, sorted), keeps existing fields                                                                                                                                                       |
| DB           | `packages/db/src/scrape/kickoff.ts` (new), `scrape/index.ts`                                   | `loadKickoffEvidence(exec, { eventIds, now })` → per event: event row, statements (section 2 filter, `sourceFresh` computed in SQL with the same predicates), latest person record; `listSourceKickoffFacts(exec, { now })` (per enabled source: healthy, known, stale, latest ok run start; used by the loader and by fixture promotion); `recordKickoffConfirmation(tx, { eventId, startTime, evidenceKey, actor, via, itemId })` (writeAudit, actor admin) |
| K1 pass      | `apps/scraper/src/pipeline/kickoff-safety.ts` (new)                                            | `closeBettingOnEarlierKickoff(ctx)`: list open, scheduled, unresulted scraped events with `start_time > now`; assess; per event to close: transaction as in K1; publish after COMMIT; summary `{ checked, closed, failed, published }`                                                                                                                                                                                                                        |
| Promotion    | `apps/scraper/src/tasks/promote.ts`                                                            | new step `['kickoff safety', …]` right after `reresolve`                                                                                                                                                                                                                                                                                                                                                                                                      |
| Fixtures     | `apps/scraper/src/pipeline/promote-fixtures.ts`                                                | compute `kickoffConfirmed` for clusters without an event (needs per-source facts: export `listSourceKickoffFacts` from the DB module); `applyKickoff` aborts F4b when `locked.bettingOpen`; `applyCreate` audit metadata adds `kickoffConfirmed`, `kickoffBasis`                                                                                                                                                                                              |
| Demo         | `apps/scraper/src/devtools/seed-result-demo.ts`                                                | pass `kickoffConfirmed: true` (comment why)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| API guard    | `apps/api/src/modules/admin/open-betting.ts`                                                   | `assertScrapedEventMayOpen(tx, eventId, { minRatingMatches, now, kickoffChecked, actor, via, itemId })`: after the scraped/open check: `kickoff_too_close`, then K2 (`loadKickoffEvidence` + `assessKickoff`, C3 recording), then O1, O2                                                                                                                                                                                                                      |
| API routes   | `apps/api/src/modules/admin/feed.ts` (`open_betting`), `trading.ts`                            | pass the new arguments; nothing else                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Contracts    | `packages/contracts/src/feed.ts`, `admin.ts`                                                   | `KickoffCheck = z.strictObject({ startTime: IsoDateTime, evidenceKey: /^[0-9a-f]{64}$/ })`; optional `kickoffChecked` on `open_betting` and `EventBettingRequest`; `KickoffUnconfirmedDetails` schema for the 422                                                                                                                                                                                                                                             |
| Admin UI     | `apps/admin/src/app/feed/review/[id]/page.tsx`, `app/trading/[id]/page.tsx`, `src/lib/feed.ts` | on 422 `kickoff_unconfirmed` show the statements and the checkbox (section 8), resend with `kickoffChecked`; reason texts; summary for `<feedRef>\|earlier` items                                                                                                                                                                                                                                                                                             |
| Docs         | `docs/scraper.md`, `docs/scraper-operations.md`, `docs/scraper-plan/known-limits.md`           | rules K1 to K6 as section 6.1a; F4 (F4b needs betting closed), F7 (needs K2), "O1 and O2 when a person opens betting" (also K2), S4 (K1 exception if decided), constants, section 9 (replay test); operations text of section 8; known-limits: C2 trusts one source's clock, stale rows still affect F1-F4                                                                                                                                                    |

Order of work (each step is committed with its tests green):

1. **Spec and F4 fixes.** `docs/scraper.md` rules; gate payload fix (`currentKickoff`, `sources`) and K4 (gate +
   `applyKickoff` re-check). Tests: `fixture.test.ts`, `apps/scraper/test/review-payload.test.ts` (an F4 item
   parses with the contract and `apply_kickoff` succeeds on it in `admin-feed.test.ts`).
2. **Pure core.** Constants, `gates/kickoff.ts`, `kickoffConfirmed` gate input (pipeline passes the computed value
   from step 4; until then it passes `false`, which only turns auto-open off), demo change. Tests: `kickoff.test.ts`,
   `fixture.test.ts`, `reference.test.ts` (new input).
3. **DB.** `scrape/kickoff.ts` loader and record. Test: `packages/db/test/scrape-kickoff.test.ts`.
4. **Scraper.** K1 pass, promote step, creation-time confirmation. Tests: `kickoff-safety.test.ts`,
   `kickoff-safety-static.test.ts`.
5. **API, contracts, admin UI.** Guard, routes, schemas, pages; update the existing open tests. Tests:
   `admin-kickoff-guard.test.ts`, `feed.test.ts` (contracts), `apps/admin/src/lib/feed.test.ts`.
6. **Replay acceptance and operations.** Generator, fixture, test; `scraper-operations.md`; `known-limits.md`;
   F-01 row of the scorecard marked done by the owner after review.

## 7. Test plan

### 7.1 Unit (`packages/scraper/src/gates/kickoff.test.ts`, `fixture.test.ts`)

One test per rule and boundary, named by rule id: K1 fires one millisecond before `start − tolerance`, not at
it; window edges (`start − 7 d` in, `− 7 d − 1 ms` out); result `finished` earlier fires, `postponed`
earlier does not (K5); acknowledged statement silent, same statement after `changed_at` moves fires; person record
for another start ignored; C1 with two sources of one upstream fails, two upstreams pass, one not fresh fails;
C2 at `start − 72 h` passes, `− 72 h − 1 ms` fails; `changed_at = now − 24 h` passes, `+1 ms` fails; unknown
freshness fails; stale fails; any dissent blocks C1/C2; C3 with an unacknowledged dissent fails; reasons list;
evidence key changes with any field and not with statement order. Gate: F7 with `kickoffConfirmed: false` never
opens and gives `kickoff_unconfirmed`; F4b with betting open gives `betting_open`; F4 payload fields.

### 7.2 Property tests (fast-check, same file; `fast-check` 4.10.2 is already a dependency)

Let S be a set of statements, a = assessKickoff(start, now, S, person).

- **P1 never opens:** for all inputs, `earlierKickoffAction ∈ {none, close}` and `close ⇒ event.bettingOpen`.
- **P2 closing is monotone in evidence:** `close(S) ⇒ close(S ∪ {o})` for any statement o.
- **P3 confirmation is anti-monotone in dissent:** o not agreeing ⇒ (`confirmed(S ∪ {o}) ⇒ confirmed(S)`).
- **P4 one upstream needs the lead or a person:** if the agreeing statements of S have fewer than two independent
  upstreams and a is confirmed, then `now ≥ start − KICKOFF_CONFIRM_LEAD_MS` or `basis = C3`.
- **P5 independence:** adding a copy of a statement under another `sourceId` with the same upstream (any case,
  padding) never changes `confirmed`.
- **P6 tolerance:** `|o.kickoff − start| ≤ KICKOFF_TOLERANCE_MS ⇒ o ∉ earlier`.
- **P7 acknowledgement:** a person record with `startTime ≠ start` gives the same result as no record; with
  `startTime = start`, statements with `changedAt ≤ confirmedAt` are never in `earlier`.
- **P8 order:** permuting S changes nothing (including `evidenceKey`).
- **P9 freshness:** if no agreeing statement has `sourceFresh`, then `basis ∉ {C1, C2}`.
- **P10 gate:** for all `decideFixture` inputs with `kickoffConfirmed = false`, no `create` has `openBetting`;
  with `event.bettingOpen = true`, no `update-kickoff` has rule `F4b`.

### 7.3 Integration (real Postgres)

- `packages/db/test/scrape-kickoff.test.ts`: statement filter (keyless old-day row excluded after the next ok
  run; disabled source excluded; 304 sighting keeps a row in; window), `sourceFresh` (known, stale, healthy),
  person record round trip, latest record wins.
- `apps/scraper/test/kickoff-safety.test.ts` (Harness, `apps/scraper/test/helpers.ts`; openfootball source,
  policy enabled, `auto_open` on, calibrated teams):
  1. created at `T0` (the harness `KICKOFF`, 4 days ahead): betting closed, `odds_approval` reason
     `kickoff_unconfirmed`;
  2. betting opened (person record + flag via the DB helpers); the served file moves the match 19 h earlier; run
     and `runPromotion`: `betting_open = false`, one audit `scrape.fixture.betting_closed`, one critical item
     `<feedRef>|earlier` whose payload parses with the contract; row snapshots of section 4 unchanged; a bet placed
     before is unchanged;
  3. second `runPromotion`: no new audit, item `updated_at` unchanged (K6);
  4. person record for the start after the report, re-open: next pass leaves it open; the file moves to yet
     another earlier time: closed again;
  5. clock to start − 71 h with the source fresh and unchanged 24 h: assessment C2; with a listed match unscored
     48 h after its end: not confirmed (`source_not_fresh`);
  6. F4b with betting open: no move, `kickoff_change` reason `betting_open`.
- `apps/scraper/test/kickoff-safety-static.test.ts`: section 4 static checks.
- `apps/api/test/admin-kickoff-guard.test.ts`: both open paths: 422 `kickoff_unconfirmed` with details; resend with
  the flag opens and writes one `scrape.fixture.kickoff_confirmed`; 409 `kickoff_evidence_changed` after a
  statement changes; 409 `kickoff_changed` for another start; 422 `kickoff_too_close` on the Trading switch; a
  refused O1 leaves no record; closing never checked; a non-scraped event opens as before. Update
  `admin-trading-open.test.ts` and the `open_betting` cases of `admin-feed.test.ts` with a helper
  `openScraped(eventId)` (call, read the 422 details, resend with `kickoffChecked`).

### 7.4 Replay acceptance (`apps/scraper/test/kickoff-replay.test.ts`, pure, no network)

- Generator `apps/scraper/src/eval/kickoff-replay.ts --hist <dir> --fpl <dir> --out <json>` (same style as
  `data-history.ts`) writes `apps/scraper/test/fixtures/kickoff-history-en1.json`: per season the usable commit
  times, and per match `{ home, away, truthUtc, listings: [[commitIndex, kickoffUtc | null, scored]] }` (only
  changes). Size well under 200 KB. Truth: FPL `kickoff_time` (open decision 5).
- The test simulates exactly section 1.3 (hourly evaluation plus every commit and every threshold edge) with the
  real `assessKickoff`, `earlierKickoffAction` and constants, and asserts: rules off reproduce 14 exposed events
  (440.0 h) and 41 wrong-at-creation (proof the fixture still holds the evidence); rules on give 0 exposed and 0
  events open at a wrong kickoff, every K1 closure is a real earlier kickoff, and correct events never openable
  without a person = 131 of 272. Exact numbers: a change of constants must update them on purpose.

## 8. Operator guidance

**K1 item** (critical), title: "Betting closed: _Home_ v _Away_ may start earlier: _source_ says _date time_
(ours _date time_)". Shows: our kickoff, every report with source and when it changed, when betting closed, open
bets and stake. What the trader does:

1. Check the kickoff on an official site (league or club).
2. Reported time is right and still at least 10 minutes away: **Apply new kickoff** on the item. Betting stays
   closed; open it in Trading if wanted (until a source confirms the new time, the confirmation of step 4 is
   asked for).
3. Reported time is right and the match has started or been played: leave betting closed; the result comes
   through the result items as usual. Bets placed after the real kickoff are not touched automatically; what to
   do with them is a house-rules decision made in Trading (open decision 4).
4. Our time is right (the source is wrong): dismiss the item with a note, then **Open betting** in Trading. The
   server shows why it is unconfirmed; tick **"I checked the kickoff on an official site: _date time_"** and open.
   The same reports will not close it again; a new report will.

**F7 item** `odds_approval` with reason `kickoff_unconfirmed`: "Betting stays closed until the kickoff is
confirmed: a second independent source agrees; or, within 72 hours of kickoff, the time has not changed for 24
hours and the source is up to date; or you check it on an official site and confirm it when you open betting."

**Changes to `docs/scraper-operations.md`:** a "Kickoff safety" subsection with the two texts above; the
"Other items" paragraph gains the `|earlier` item and the `kickoff_unconfirmed` reason; "Who can do what" gains
"Confirm a kickoff (while opening betting): `trading.status`"; the stop-the-scraper paragraph notes that while
the scraper runs it closes betting by itself on earlier-kickoff reports (stopping it stops that too).

## 9. Open decisions for the owner

1. **K1 when the competition policy is off (S4).** S4 says nothing happens by itself. Recommended: K1 still closes
   (it only reduces exposure); S4 gets that one exception in `scraper.md`.
2. **Person confirmation (C3).** Without it, 48% of correct events on today's single source can never open.
   Recommended: ship it as specified (bound to the evidence key, audited).
3. **Auto-open once confirmed later.** Recommended: no; `auto_open` stays creation-only and the K rules never open.
4. **Bets placed between the real kickoff and the K1 closure** (measured 0 with K1+K2, but possible on a C3
   override). Recommended: a written house rule, applied by a person in Trading; nothing automatic.
5. **Committing FPL-derived truth in the replay fixture.** Check the terms of the FPL data mirror. Recommended
   fallback if not allowed: use openfootball's own final 2025-26 file as truth (equal to FPL for 380 of 380) and
   drop the 2026-27 projection from the test.
6. **Thresholds.** Recommended: 72 h lead, 24 h stable, 7-day window as above; re-measure with the replay test once a
   second upstream exists, since C1 then carries most openings.

### Decisions taken (2026-10-30, for the owner, who delegated them)

All six recommended defaults are adopted:

1. K1 closes betting even when the competition policy is off; S4 in `scraper.md` gets that one exception.
2. Person confirmation (C3) ships as specified.
3. Nothing opens betting by itself once a kickoff becomes confirmed later (`auto_open` stays creation-only).
4. Bets placed between the real kickoff and the closure are a house-rules decision made by a person in Trading;
   nothing is automatic. (The wider question of stake and liability limits is the exposure policy, F-05.)
5. The committed replay fixture uses openfootball's own final 2025-26 file as truth (it equals FPL for 380 of 380
   matches), so no FPL-derived data is committed; the 2026-27 projection is not part of the test.
6. Thresholds stay 72 h lead, 24 h stable, 7-day window; re-measure with the replay once a second upstream exists.
