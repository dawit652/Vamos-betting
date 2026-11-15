# Hulusport prices through mr-x

Written 14 November 2026. Status: **built, switched off.** Nothing changes for players until someone turns the switch on in the back office. mr-x runs on the server since 14 November (`/opt/mr-x`).

## The decision

On 14 November 2026 the owner decided to copy Hulusport's odds into Nahubet's board, with our margin. The owner also wanted a back office switch to go back to our own prices at any time.

The owner was told the risk first: copying a competitor's prices to our players probably breaks Hulusport's terms. It is the same reason odds-api.io was ruled out in [hulusport-parity-plan.md](hulusport-parity-plan.md). The owner chose to go ahead.

## How it works

```
Hulusport API ──> mr-x poller ──> odds.db ──> mr-x GET /api/board
                                                     │
              Nahubet scraper, task "hulusport" <────┘   (every 2 minutes)
                     │  match by the two teams and the kickoff
                     ▼
              scrape_board_odds (one row per match)
                     │  only while the switch hulusport_pricing is on
                     ▼
              priceEvent: boardRule ──> O6, O7 ──> re-price (bounds of O3) ──> catalogue
```

1. **mr-x** (`C:\Users\dawit\mr-x`, the owner's own tool) polls Hulusport. It serves the board at `GET /api/board`: every upcoming match, its markets in Hulusport's own shape, and `odds_checked_at`, the time it last read that match. Nahubet never calls Hulusport itself.
2. **The scraper's `hulusport` task** (`apps/scraper/src/tasks/hulusport.ts`) runs when `SCRAPER_HULUSPORT_URL` is set. It reads the board and stores each match in `scrape_board_odds`. A match is linked to our event when both team names resolve (rule N2, global aliases included) and exactly one scraped event has those two teams within 6 hours of the kickoff. The competition is not compared, because the two sites name competitions differently. Home and away must match: a swapped match never links.
3. **The pricing step** (`boardRule` in `apps/scraper/src/pipeline/event-pricing.ts`) acts only while the switch is on. Every market we already price that the board also quotes, fresh and complete, takes the board's prices, with Hulusport's margin removed and ours applied (`priceBoardMarkets` in `@vamos/feed`). The rest of the pricing rules then apply as before: half-time markets (O6), out-of-line alarms and the cap (O7), and the re-pricing bounds (O3).
4. **Matches we do not list** (`apps/scraper/src/pipeline/board-events.ts`). The owner decided on 14 November 2026 that every league the board brings is shown. A board match that links to none of our events becomes an event of its own (feed_provider `hulusport`), in a competition and with teams created for it (`scrape_board_competitions`, `scrape_board_teams`, migration 0048), priced from the board alone, every quoted market, with our margin.

## Hulusport-only matches

- **Only while the switch is on.** With the switch off, no new ones are created and the existing ones are suspended.
- **Never a second copy of one of our matches.** A league is ours when one of its board matches links to our event, or when its name resolves to one of our competitions. A match with a team of our own catalogue is never created either. Both fail closed: such a match is not listed (it shows in the panel's "not linked" list if its names did not resolve). For example, another country's "Premier League" is not listed, because the name resolves to ours.
- **Names.** The competition takes Hulusport's league name, in a category named after the country (`Other` when unknown). If a competition already has that name, the country is added, so no name becomes ambiguous for the other sources. Teams take Hulusport's names.
- **Opening and pausing.** Betting is open from creation (owner's choice), and closes 5 minutes before kickoff. Each read re-prices the match, suspends the markets Hulusport dropped, and re-opens the ones it quotes again (never a trader's suspension). After every read, also a failed one, an upcoming match whose Hulusport prices are older than 30 minutes is suspended whole.
- **Results from API-Football** (owner's results subscription; `apps/scraper/src/tasks/board-results.ts`, migration 0049). The task runs every 15 minutes, and only when `SCRAPER_SECRET_API_FOOTBALL` is set.
  - **Which matches:** those that kicked off between 2 hours and 3 days ago and have no result.
  - **Requests:** one per kickoff day (`/fixtures?date=`), at most four days per pass. That is about 200 requests a day at most, far under the 7,500 of the Pro plan; the free plan's 100 a day is not enough.
  - **Matching:** each match is paired with exactly one fixture, by kickoff within 15 minutes and both team names, home as home. Names are compared without legal forms, and with "Utd" read as "United".
  - **Settling:** a finished fixture (FT, AET, PEN) gives the 90-minute and half-time scores. They settle the bets (`resultEvent`) once the same score has stood for 15 minutes.
  - **One source decides**, by the owner's choice; the 15-minute wait guards against a score corrected right after the whistle. Every applied result is audited as `scrape.board.result_applied`.
- **What still needs a person.** The Feed page lists the matches that kicked off more than two hours ago and have no result, each linked to its trading page. That covers no API-Football match found, a postponed, cancelled or abandoned match, a half-time score missing for a half-time market, and anything older than 3 days.
- **mr-x follows the next 300 matches** (`WATCHLIST_SIZE=300` in `/opt/mr-x/.env`, owner's choice). Each match is then read about every 20 minutes, inside the 30-minute limit.

## What is taken from Hulusport

| Hulusport market       | Nahubet market        | Note                                      |
| ---------------------- | --------------------- | ----------------------------------------- |
| 3 Way                  | 1X2 (`1x2`)           | Required: without it nothing is taken     |
| Double chance          | `dc`                  | Fair total 2: each result is in two picks |
| Over/Under (x.5 lines) | `ou`                  | Whole and quarter lines are skipped       |
| Handicap {hcp} "a:b"   | 3-way handicap (`eh`) | Home line = a − b; 0:0 is skipped         |
| Both teams to score    | `btts`                |                                           |
| Draw no bet            | `dnb`                 |                                           |
| 1st Half - 3 Way       | `ht_1x2`              | Still subject to O6                       |

Not taken:

- **Correct score.** Hulusport lists only scores up to six goals, caps long shots at 101 and has no "any other score". The book cannot be completed.
- **Asian handicap.** Hulusport does not offer it.
- **The other ~100 Hulusport markets.** Vamos can only offer and settle its own nine market types.
- **Lines we do not price ourselves** (for example a handicap of −3). The catalogue never removes a market a later price leaves out. So a line that only Hulusport offers would keep an old price once Hulusport dropped it.

## Safety rules

- **Off by default.** The switch is the settings row `hulusport_pricing`. A missing row, or anything other than `{"enabled": true}`, counts as off.
- **Who may switch.** Turning it on needs `settings.edit`. Turning it off needs only `trading.status`, the same as the kill switch of a competition. Both are audited as `scrape.hulusport_pricing.updated`.
- **Fresh only.** Prices older than 30 minutes are not used (`BOARD_PRICES_MAX_AGE_MS`). This counts both mr-x's last read of the match and our last read of the board. The event then goes back to our own prices through the normal re-pricing bounds. If mr-x stops, or its poller is blocked, the prices expire by themselves.
- **Complete, sane books only.** Every selection must be listed and available, priced 1.01 to 1000. The overround must be at least the fair total and at most 1.5 times it. The board's 1X2 must be among the markets taken.
- **Conflicts fail closed.** If two board rows link to one event, nothing is used. A name that does not resolve links nothing.
- **Same bounds as any re-price.** A move larger than the O3 bounds is held for a trader, and the event is suspended meanwhile (A2, `reprice_held`). Pricing keys carry `|hl:<digest>`, so a move on Hulusport re-prices the event. A held proposal with Hulusport prices is applied like a market proposal (the exact held key).
- **The audit trail.** Every re-price with Hulusport prices records `board`, `boardMarkets` and `boardPricesAt`.

## Setting it up

On the machine that runs mr-x:

```powershell
cd C:\Users\dawit\mr-x
node poller.js            # reads Hulusport; WATCHLIST_SIZE (default 30), WATCH_LEAGUES optional
node server.js            # the board on http://127.0.0.1:3100 (PORT, HOST)
```

`WATCH_LEAGUES` takes Hulusport league ids or exact league names, separated by commas, for example `Premier League,LaLiga`. Without it, mr-x polls the next 30 soccer matches of any league, and most of those are leagues Nahubet does not list.

In Nahubet's environment, set `SCRAPER_HULUSPORT_URL=http://127.0.0.1:3100` (and optionally `SCRAPER_HULUSPORT_INTERVAL_SECONDS`). Then turn the switch on in the back office: Feed, Hulusport prices. The same panel shows how many board matches linked, how fresh the prices are, and which matches did not link.

### On the server

mr-x runs from `/opt/mr-x` as its own compose project (`mrx`, files `Dockerfile` and `docker-compose.yml` in the mr-x folder):

- two containers from one image, `poller` and `api`, both `restart: unless-stopped`, so they come back after a reboot;
- `odds.db` in the `mrx_data` volume;
- the API joins Nahubet's network `vamos_vamos` under the name `mrx`, and no port is published. The board has no authentication, so it must stay private.

In `/opt/nahubet-new/infra/.env.prod`, set `SCRAPER_HULUSPORT_URL=http://mrx:3100`. If the Nahubet stack is ever removed with `docker compose down`, recreate it before starting mr-x: mr-x needs that network to exist.

## Open points

- **Hulusport may refuse the server's address.** The server is in Germany, and an old test script used an Ethiopian proxy. If the poller logs HTTP 403 or keeps backing off, the board stays empty and Nahubet keeps its own prices.
- **Hulusport's TLS certificate expired on 14 October 2026.** mr-x connects with certificate checks off (`rejectUnauthorized: false`). Anyone between mr-x and Hulusport could feed it false odds, and those would become our prices. The safe fix is to accept only Hulusport's known public key (pinning) while its certificate stays expired, and normal checks once it is renewed.
- **Mixed books.** When Hulusport lacks a market that we price, that market keeps our price next to Hulusport-based ones. Accumulators cannot combine markets of one match (`duplicate_event`), but two singles on related markets could find an edge if the two prices disagree by more than the margin. Watch the out-of-line alarms after switching on.
- **Close-price measurement** (`scrape_close_prices`) still labels such events `market` or `model` by their base key.
