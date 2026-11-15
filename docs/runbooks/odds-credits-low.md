# Odds credits low, key refused or prices stale

Use it when a `source_broken` review item is open with one of the reasons below. They come from the bookmaker
odds feed (The Odds API, adapter `theoddsapi`; the design is in
[`docs/theoddsapi-plan/README.md`](../theoddsapi-plan/README.md), sections 4.5 to 4.8). Open the items with
`/feed/review?status=open&kind=source_broken`; the back-office `/feed` page has a **Bookmaker odds credits** panel
with the credits left, the guard's mode and each league's last read and next kickoff.

**Severity:** SEV3. The feed only sets prices for competitions switched to market pricing. When it stops, those
matches keep their last prices (they never fall back to the model by themselves), and no money moves. Raise it
to SEV2 when a market-priced match with open bets is within a few hours of kickoff with stale prices: switch that
competition back to `model` (step 5).

## What each reason means

| Reason             | What happened                                                                                                                                                               | It resolves itself when      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `budget_low`       | Under 20% of the month's credits left with more than 7 days to go, or more than 7.5% spent in 24 h (economy), or under 10% left (minimal: only matches within 3 h are read) | the guard is normal again    |
| `budget_exhausted` | Under 1% left: nothing is read until the 1st (UTC)                                                                                                                          | credits are back on the 1st  |
| `unauthorized`     | The API answered 401: a wrong or deactivated key, or no credits left at all                                                                                                 | a read with the key succeeds |
| `unexpected_cost`  | A request cost more than the 2 credits expected (a book list over 10, or a changed API default)                                                                             | never: a person dismisses it |
| `market_stale`     | A market-priced match within 24 h of kickoff kept prices the market no longer backs                                                                                         | fresh prices price it again  |

The first four reasons also text the owner's phone when `OWNER_ALERT_PHONES` is set (once when the item
opens, and again if `budget_low` becomes `budget_exhausted`); the text says what the guard already did, for
example "odds reads are stopped until the 1st" ([`docs/scraper.md` 6.3a](../scraper.md)).

## 1. Look at the credits

On `/feed`, read the panel: credits left of the quota, spent in the last 24 h, the mode, and per league the last
read and the next kickoff. In a normal month the five leagues use about 13,500 of 20,000 credits (68%); the guard
should never leave `normal`. If it does, find out why before doing anything else:

- **Spent in 24 h is high** (above 1,500 on the 20K plan): a league is read more often than it should be. Check
  that no source is listed twice with the same league, and that nobody runs sources by hand in a loop.
- **A heavy month** (extra rounds, cup weeks): expected. Let the guard work; it reads less often and never runs out.
- **A second consumer of the key** (a test machine, a script): the key is only for production (rule G5).
  Development and staging use a separate free-plan key.

## 2. `unexpected_cost`

Open the source's config (`/feed`, the source's row) and check `bookmakers` has at most 10 entries and `markets`
only `h2h` and `totals`. If both are right, The Odds API changed its pricing: note it, dismiss the item, and
watch the next runs. If it keeps happening, disable the source until the config is fixed.

## 3. `unauthorized`

1. Log in to the account at https://the-odds-api.com and check the subscription is active and has credits.
2. If the key was rotated or is wrong, put the new one in the production environment as
   `SCRAPER_SECRET_THEODDSAPI` and restart the scraper (see [rotating secrets](rotating-secrets.md)). Never paste the
   key into a ticket, chat or the source config.
3. The guard stops the key after a 401. To let it try again, disable and re-enable one league source on `/feed`;
   the next successful read resolves the item.

## 4. `budget_exhausted`

Nothing is read until the 1st (UTC). Decide with the owner:

- wait for the 1st (market-priced matches keep their last prices, and `market_stale` items will open near
  kickoff), or
- move to a bigger plan on the account page (the 100K plan is about 59 USD), then disable and re-enable one source
  so the guard reads the new quota at once.

## 5. `market_stale`

The match keeps its last prices because the market cannot back new ones (stale data, fewer than two books, no
over/under line, or a fit too poor to trust). If the credits are fine and the league source is healthy, it usually
clears at the next read. Within 3 hours of kickoff the scraper suspends the match's markets by itself when no
bookmaker price is younger than 30 minutes (rule A2), and re-opens them when fresh prices arrive; a trader can
re-open them earlier on Trading. If kickoff is near and the match has open bets, switch the competition back to
`model` on `/feed` (Competitions, pricing source): the next re-pricing pass prices it from the team ratings,
through the usual bounds and trader approval.

## Record

Add a line to the incident log: the reason, the credits left, what you changed, and when the item resolved.
