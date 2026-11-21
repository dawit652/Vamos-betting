# Narobet prices through mr-z

Written 21 November 2026. Status: **built, switched off.** Nothing changes for players until
someone turns the switch on in the back office. mr-z runs on the server since 21 November
(`/opt/mr-z`, next to mr-x). Before every push, build on top of the server's branch:
`git fetch origin live/nahubet-new-2026-11-15 && git merge-base --is-ancestor FETCH_HEAD HEAD`.

## The decision

On 21 November 2026 the owner asked to connect the mr-z API (`dawit652/mr-z`, which reads Narobet)
to Nahubet, the same way as Hulusport's prices through mr-x
([hulusport-feed.md](hulusport-feed.md)): Narobet's odds with our margin instead of Narobet's,
behind a back office switch, and mr-z not limited to a list of leagues. The same caveat as for
Hulusport applies: copying a competitor's prices to our players may break its terms.

The owner also asked (21 Nov) that mr-z **not pull data aggressively** from Narobet (see "How mr-z
reads Narobet").

## What the first release does, and does not do

- **Only matches Nahubet already lists and prices.** For those matches, Narobet's prices replace
  ours in the markets we already price. Narobet adds no market and no match. A match that Narobet
  lists and we do not is shown under "Not linked" and is otherwise ignored.
- **Only while `narobet_pricing` is on** (a setting, off by default; Feed page, "mr-z prices").
  Turning it on needs `settings.edit`. Turning it off (back to our own prices) needs only
  `trading.status`, like Hulusport's switch. Each change is audited as
  `scrape.narobet_pricing.updated`.
- **Hulusport first.** While Hulusport's switch is on and a match has fresh Hulusport prices, those
  win. Narobet is the second choice, and our own prices the last.
- **Fresh prices only**, by the time left to the kickoff. Each limit is mr-z's re-read pace plus
  slack for one late read:

  | Kickoff in | mr-z re-reads every | Narobet prices used up to |
  | ---------- | ------------------- | ------------------------- |
  | 3 hours    | 10 minutes          | 20 minutes old            |
  | 24 hours   | 30 minutes          | 45 minutes old            |
  | later      | 6 hours             | 7 hours old               |

  Older prices, or a failed read, bring our own prices back on the next pricing pass.

- **Not done:** no whole-match pricing (rule O1h stays Hulusport's only), no Narobet-only events,
  and no results from mr-z. Release 2 (Narobet-only matches, results by API-Football fixture id) is
  built and switched off: [narobet-events.md](narobet-events.md).
- **Kickoff confirmation (K2):** Narobet's data comes from API-Football, so it is not an
  independent second source for a kickoff time. Matches more than 72 hours away stay locked as
  before.

## How it works

1. **mr-z** (its own repository, deployed by the owner at `/opt/mr-z`, compose project `mrz`)
   reads Narobet into SQLite and serves `GET /api/matches` on Nahubet's private network as
   `http://mrz:3200`. No port is published.
2. **The scraper** (`apps/scraper/src/tasks/narobet.ts`) reads
   `/api/matches?sport=football&status=SCHEDULED&markets=1X2,FIRST_HALF_WINNER,DOUBLE_CHANCE,OVER_UNDER,BTTS,DRAW_NO_BET`
   every 5 minutes (`SCRAPER_NAROBET_INTERVAL_SECONDS`, default 300). It reads only while
   `SCRAPER_NAROBET_URL` is set. The traffic stays on the server: only mr-z talks to Narobet.
3. **The parser** (`packages/scraper/src/adapters/narobet.ts`, `parseMrzMatches`) keeps complete
   books only: 1X2 → `1x2`, first half winner → `ht_1x2`, double chance → `dc`, each
   over/under line → `ou`, both teams to score → `btts`, draw no bet → `dnb`. Matches with no
   markets yet, or past their kickoff, are skipped.
4. **Linking.** Team names resolve as every source's do (aliases, catalogue names). A match links
   to the Nahubet event with the same two teams within the usual window. Each read is stored in
   `scrape_board_odds` as board `narobet` (migration `0076_narobet_board`), one row per mr-z match
   (`narobet:<id>`). `pricesAt` is when mr-z last read the match's markets from Narobet.
5. **Pricing** (`apps/scraper/src/pipeline/event-pricing.ts`, `boardRule`) picks Hulusport, then
   Narobet, under the freshness rules above (`narobetPricesMaxAgeMs` and `NAROBET_FRESHNESS_STEPS`
   in `packages/scraper/src/constants.ts`). Narobet's margin is removed and ours is applied
   (`priceBoardMarket`), as for Hulusport.
6. **Back office:** `GET /admin/feed/narobet` (`trading.view`) and `PUT /admin/feed/narobet`. The
   Feed page panel "mr-z prices" shows the switch, when the board was last read, upcoming, linked
   and fresh counts, and the matches that did not link (add an alias for an unknown team name).

## How mr-z reads Narobet (gently)

Owner's rule, 21 Nov 2026: mr-z must not pull data aggressively (mr-z commit `7f129c6`):

- one request at a time, 2 seconds after each, and at most 50 match details per 3-minute cycle;
- **at most 1200 requests in any hour**, retries included. When the hour is full, the cycle stops;
- **a refusal is never retried.** On HTTP 401, 403 or 429, a redirect, or a Cloudflare challenge,
  mr-z stops at once and waits 15 minutes. Each further refusal in a row doubles the wait, up to
  6 hours, or longer if Narobet's `Retry-After` says so;
- only football (all Narobet offers today), 30 days ahead, all leagues;
- live matches are re-read every 10 minutes and unconfirmed results every 60 minutes, because
  Nahubet uses neither. The far list days are re-read every hour.

Before, mr-z sent up to three requests at once, 0.15 seconds apart (about 75 a minute), and kept
going after a refusal. The settings are in `/opt/mr-z/.env`. Do not raise them without the owner.

## Deploy (by the owner; never by a session)

1. mr-z: `cd /opt/mr-z && git pull && docker compose up -d --build`. If `/opt/mr-z/.env` sets
   `POLL_SECONDS`, `DETAIL_BUDGET`, `CONCURRENCY` or `REQUEST_GAP_MS`, remove those lines so the
   gentle defaults apply.
2. Nahubet: add `SCRAPER_NAROBET_URL=http://mrz:3200` to `/opt/nahubet-new/infra/.env.prod`, then
   the usual `infra/scripts/deploy-full.sh`, which runs migration 0076.
3. Back office → Feed → "mr-z prices": check that the board is read and see how many matches link.
   Turn the switch on only when the counts look right.

## Tests

`packages/scraper/src/adapters/narobet.test.ts`, `packages/scraper/src/narobet-freshness.test.ts`,
`packages/db/test/scrape-board-narobet.test.ts`, `apps/scraper/test/narobet-board.test.ts` and the
"Narobet prices" block of `apps/api/test/admin-feed.test.ts`.
