# Narobet-only matches through mr-z (more leagues on nahubet.com)

Written 21 November 2026. Status: **planned, not built.** Release 2 of
[narobet-feed.md](narobet-feed.md). Before every push, build on top of the server's branch:
`git fetch origin live/nahubet-new-2026-11-15 && git merge-base --is-ancestor FETCH_HEAD HEAD`.
The next free migration number was **0077** when this was written; restamp it if the server's
branch has taken it.

## Why

On 21 November 2026 the owner asked why nahubet.com shows so few leagues, and said "go ahead" to
connecting mr-z for more of them. Nahubet lists about a dozen leagues of its own. mr-z reads about
900 Narobet matches over the next 3 days, in at least 233 leagues. Release 1 only re-prices the
matches Nahubet already lists. It adds no match and no league. This release lists the Narobet
matches Nahubet does not have, as Hulusport's board already can
([hulusport-feed.md](hulusport-feed.md), "Hulusport-only matches").

## The owner's rules

1. **Narobet must not be affected** (owner, 21 Nov: "make sure when mr-z pulls data from narobet,
   narobet should not be affected").
   - Nahubet never contacts Narobet. Only mr-z does, within its gentle limits
     ([narobet-feed.md](narobet-feed.md), "How mr-z reads Narobet"): one request at a time, 2
     seconds apart, at most 1200 an hour, and it stops at once when Narobet refuses. On 21 Nov it
     sent about 43 requests every 3 minutes.
   - This release adds **no request to Narobet**. It changes no mr-z setting: no more markets, no
     faster re-reads, no live reads. Nahubet keeps reading mr-z's own copy once every 5 minutes.
     Results come from API-Football and from what mr-z has already stored.
   - If a match's prices cannot stay fresh at mr-z's pace, the match stays suspended. Never speed
     mr-z up to fix that.
2. **Every league** mr-z brings is listed. The owner gave the same rule for Hulusport on 14 Nov,
   and asked on 21 Nov that mr-z not be limited to a list of leagues.
3. **Off by default**, behind a back-office switch, like every board feature.

## What players will see

Narobet matches in leagues Nahubet does not list appear as matches of their own:

- **League:** mr-z's league name, in a category named after the country.
- **Teams:** mr-z's team names.
- **Markets:** Narobet's markets as release 1 reads them, with our margin instead of Narobet's.
  These are 1X2, first-half 1X2 (rule O6 still applies), double chance, each over/under line,
  both teams to score and draw no bet. The factory markets follow `SCRAPER_FACTORY_MARKETS`,
  exactly as for Hulusport's matches.

Betting is open while the prices are fresh and closes 5 minutes before the kickoff.

## How it works

### Which mr-z matches become events

A match from the list release 1 already reads (`MRZ_MATCHES_PATH`, scheduled matches only) is
created only when all of these hold:

- the switch `narobet_events` is on (decision D1);
- it links to none of our events (release 1's linking, unchanged);
- it carries API-Football's fixture id (`apiId`) and league id (`leagueApiId`). Both were checked
  on 21 Nov: mr-z's match `1640380` is API-Football's fixture 1640380 (Columbus Crew v St. Louis
  City, US Open Cup, league 257). Without both ids the match is skipped;
- its league is not one of ours, and neither of its teams is ours (see "Never a second copy");
- its book has a complete 1X2 and passes `checkMarkets`;
- its prices are fresh by release 1's graded rule (`narobetPricesMaxAgeMs`): 20 minutes within 3
  hours of the kickoff, 45 minutes within 24 hours;
- its kickoff is more than `MIN_LEAD_MS` away and within the horizon (decision D2: 24 hours
  recommended).

At most **100 new events per read**. The first fill then spreads over about 45 minutes instead of
landing all at once.

### Never a second copy of a match

Every check fails closed: when in doubt the match is not listed, and it shows in the panel with
the reason.

- **Our leagues.** A league is keyed by `leagueApiId`, not by its name. mr-z's names carry no
  country: "Premier League" alone covers England, Ethiopia, Wales and more. A league is ours when
  any of these holds:
  - one of its matches links to our event;
  - its name resolves to one of our competitions;
  - our catalogue binds API-Football league ids to our competitions (the league factory,
    `packages/scraper/src/match/bind.ts`), and its `leagueApiId` is one of them. Check in step 2
    where those ids are stored.
- **Our teams.** A match with a team of our own catalogue is never created. This is the same rule
  as Hulusport's (`sideOf` in `apps/scraper/src/pipeline/board-events.ts`).
- **Hulusport's own matches.** Both switches may be on. A Narobet match is skipped when a Hulusport
  board event has a kickoff within 15 minutes and both team names alike, home as home.
  - "Alike" means `nameSimilarity` at or above 0.6, the bar `bind.ts` already uses.
  - Hulusport's creation gets the same check against Narobet's events, so the order of the two
    reads does not matter.
- **One event per fixture.** A fixture id that appears twice in one read is skipped. So is one that
  another Narobet event already has.

### Names, opening and pausing

These reuse Hulusport's code (`ensureBoardCompetition`, `ensureBoardTeam`), keyed by board
`narobet`:

- **Competition:** mr-z's league name, in a category named after the country (`Other` when it has
  none). When the name is already taken, the country is added.
- **Teams:** mr-z's names.

Each read re-prices the match. It suspends the markets mr-z dropped and re-opens the ones it quotes
again, but never a trader's suspension. After every read, also a failed one, the sweep suspends:

- every upcoming Narobet event whose prices are no longer fresh;
- all of them while the switch is off;
- a match mr-z stops listing (postponed, cancelled or moved). Its row stops refreshing, so it goes
  stale like any other.

A moved kickoff follows mr-z: `upsertFixture` already updates the start time. mr-z re-reads the
next 3 days' list every cycle, so a new time arrives within about 10 minutes.

## Results

- **API-Football decides, by fixture id.** This extends `apps/scraper/src/tasks/board-results.ts`.
  - Narobet events carry the fixture id, so the lookup is exact: `/fixtures?ids=` takes 20 ids
    per request, with no name matching.
  - The task runs every 15 minutes, for events that kicked off 2 hours to 3 days ago and have no
    result. That is about 15 requests a day for 300 matches.
  - It runs only when `SCRAPER_SECRET_API_FOOTBALL` is set.
- **Settling** uses Hulusport's rule (`resultEvent`): FT, AET and PEN give the 90-minute and
  half-time scores. They settle once the same score has stood for 15 minutes
  (`BOARD_RESULT_CONFIRM_MS`). Each applied result is audited as `scrape.board.result_applied`.
- **mr-z cross-checks.** Read mr-z's stored results in one local request per pass:
  `/api/matches?sport=football&status=FINISHED&changed_since=<last pass>&markets=none`. That gives
  the status, the score and `result_confirmed`. `/api/matches/:id` also takes API-Football's
  fixture id. Both read mr-z's SQLite only, with no Narobet traffic (checked 21 Nov, step 0).
  - A confirmed mr-z score that differs from API-Football's stops the settlement and lists the
    match for a person.
  - A missing mr-z result does not block. Narobet's data comes from API-Football, so mr-z is a
    check against errors, not an independent source.
- **Real kickoff guard.** Bets placed after a match started must never be paid. A match may have
  started earlier than the time we showed, if mr-z missed a change. When API-Football's kickoff
  is more than 5 minutes before our close time, the result is not applied automatically. The match
  is listed for a person, who voids the late bets.
- **Left to a person** on the Feed page's "results waiting" list, as today:
  - postponed, cancelled, abandoned, awarded and walkover matches;
  - a half-time score missing for a half-time market;
  - anything older than 3 days;
  - every Narobet event, while there is no API-Football key.

## Limits for single-source matches

Most of these leagues are small: lower divisions, cups and non-league football. Each match has one
price source and one results source, and the risk of match fixing is higher there.

Recommended (decision D4): a separate, lower liability cap for board events, both Hulusport's and
Narobet's.

- It is a settings row `board_risk_limits`, `{ maxEventLiability, maxSelectionLiability }`.
- It is checked where `risk_limits` is checked today, by rule L1 (`packages/db/src/betting/risk.ts`,
  `liabilityBreach` in `@vamos/core`), for events whose feed provider is a board.
- The global limits are null by default, so today nothing caps a single small-league match.

This is on the money path. Build it in the main session, with tests.

## Back office

The Feed page panel "mr-z prices" gains:

- the switch "Narobet-only matches" (turning it on needs `settings.edit`, turning it off needs
  `trading.status`; audited as `scrape.narobet_events.updated`);
- counts of matches created, open, and suspended as stale;
- counts of matches skipped, by reason: our league, our team, probably Hulusport's match, no
  fixture id, no 1X2, not fresh, outside the horizon;
- the results waiting for a person.

## Steps (build order; one commit each, with tests)

0. **Server checks (the owner pastes the output; read-only):**
   - **Done 21 Nov:** `sed -n 60,140p /opt/mr-z/server.js` shows that `/api/matches`,
     `/api/matches/:id` and `/api/health` answer from mr-z's SQLite only and never call Narobet.
     `/api/matches` filters by `status`, `confirmed`, `changed_since`, `from`/`to` (days),
     `league_api_id`, `country` and `league`, and takes `markets=main|all|none|<list>` and
     `limit`/`offset`.
   - `grep -c '^SCRAPER_SECRET_API_FOOTBALL=.' /opt/nahubet-new/infra/.env.prod` prints `1` when
     the results key is set. The command never prints the value.
   - Release 1 is deployed (migration 0076), and the panel's linked counts look right.
1. **Migration (0077):**
   - allow board `narobet` in the checks of `scrape_board_competitions` and `scrape_board_teams`;
   - add `fixture_id integer` to `scrape_board_odds` (API-Football's id; filled for `narobet` rows).

   Events use feed provider `narobet` and `feed_ref` = mr-z's id, like Hulusport's. That keeps
   source keys and the sweep as they are. `events_feed_ref_uq` already makes the pair unique.

2. **Generalise `board-events.ts` by board:** `syncBoardEvents(ctx, board, entries, now)` and
   `sweepBoardEvents(ctx, board, now)`, with a per-board table of:
   - switch;
   - source id;
   - feed provider;
   - freshness rule (30 minutes for Hulusport, graded for Narobet);
   - horizon;
   - league key.

   `loadBoardCatalog`, `listBoardEvents` and `BOARD_FEED_PROVIDER` become per board. Hulusport's
   behaviour must not change; its tests stay as they are.

3. **The duplicate guard.** A pure `sameMatchLikely(a, b)` goes in `packages/scraper`: kickoff
   within 15 minutes, and both names alike in the same orientation. It gets property tests, then
   is wired into both boards' creation, together with the fixture-id rule.
4. **The `narobet` task** calls `syncBoardEvents('narobet')` after storing each read, and the sweep
   after every read, also a failed one. Its read of mr-z stays as it is.
5. **Switch and panel:**
   - the settings row `narobet_events`;
   - `GET` and `PUT /admin/feed/narobet` extended, with the audit entry;
   - the panel described above.
6. **Results:** API-Football by fixture ids (extend `packages/scraper/src/adapters/apifootball-results.ts`
   with a scrubbed fixture), the mr-z cross-check and the real kickoff guard. This is
   integration-tested against a real Postgres.
7. **Board limits** (if D4 is yes): placement, the settings row, the back-office settings form and
   its tests.
8. **Docs:** update [narobet-feed.md](narobet-feed.md), `docs/deployment.md` (deploy and
   switch-on) and `docs/runbooks/` (results waiting, a suspected duplicate, turning it off).

Tests to add: creation and each skip reason; switch off suspends; stale sweep; the cap of 100 per
read; Hulusport unchanged; results by id; an mr-z disagreement holds settlement; the kickoff guard.

Who builds what:

| Step                                       | Who                                            |
| ------------------------------------------ | ---------------------------------------------- |
| 1, 6, 7 (migration, settlement, placement) | Main session, Opus                             |
| 2–4                                        | Main session, or `routine-coder` with a review |
| 5 (screens) and 8 (docs)                   | `routine-coder`                                |

## Decisions for the owner

| #   | Question                                     | Recommended                                                                                                    |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| D1  | A switch of its own for Narobet-only matches | Yes: turn on prices (`narobet_pricing`) first, watch them, then `narobet_events`                               |
| D2  | How far ahead to list them                   | 24 hours, where prices are at most 45 minutes old. 72 hours lists more, with prices up to 7 hours old          |
| D3  | Who decides results                          | API-Football by fixture id, with mr-z as a cross-check. Without the key, a person enters every result          |
| D4  | Lower limits for single-source matches       | Yes. The owner sets the maximum payout per match and per selection                                             |
| D5  | Leagues left out even under "every league"   | None, except club friendlies (weak results data, high fixing risk). Youth, reserve and women's leagues stay in |

## Load (Narobet not affected)

| Who → whom             | Before                                               | After                                                    |
| ---------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| mr-z → Narobet         | ≤ 1200 requests an hour, one at a time               | **unchanged**                                            |
| Nahubet → mr-z         | one list read every 5 minutes (on the server)        | the same, plus a few local result reads every 15 minutes |
| Nahubet → API-Football | about 200 requests a day at most (Hulusport results) | about 15 more a day                                      |
