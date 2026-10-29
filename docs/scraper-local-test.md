# Try the scraper on your computer, with real data

This walks through the whole scraper flow in demo mode (play money) with **real, current Premier League data**
from the public openfootball dataset. You see: games read from the internet, turned into events with odds, a
trader opening betting, and the games appearing for players. Match results are covered in the last section.

Nothing here needs money, an account with a data provider, or the licensed-mode settings. It was run end to
end on 2026-10-29 against the real file for the 2026-27 season; the numbers below are from that run.

## What to expect, and what not

- **Odds are ours.** The scraper reads fixtures and final results. Prices come from our own model, from each
  team's ratings. It never copies bookmaker odds.
- **Betting starts closed.** Every new event waits for a trader to open it. A team's ratings must be reviewed
  first (a team that nobody reviewed is "uncalibrated"), otherwise the trader cannot open betting.
- **Results lag.** The dataset is kept by volunteers. Matches can be played a few days before their score
  appears. A faster source (a paid data provider) is the way to get results quickly.
- **One source, one vote.** Results need two independent upstreams to apply by themselves. With this single
  source a result always waits for a trader to confirm it (`result_unverified`). That is intended.

## 1. Set up the project

Follow the README (`pnpm install`, `cp .env.example .env`, start Postgres and Redis, `pnpm db:migrate`,
`pnpm db:seed`). Then change one line in `.env`:

```
FEED_PROVIDER=scraped
```

With `scraped`, the worker stops its demo simulator (fake games and drifting prices) and keeps doing
settlement and payouts, so only real games appear.

## 2. Look at the data first (nothing is written)

```bash
pnpm --filter @vamos/scraper-app cli dry-fetch --source-file docs/scraper-plan/data/source-openfootball-en1.json --limit 5
```

Expected, in October 2026: `records seen 380, accepted 375; 330 fixtures, 45 results, 5 issues`. The five
issues are matches the dataset lists with a bare `[0, 0]` instead of a proper score. The scraper refuses to
guess a score, so those five are skipped. That is the safe behaviour.

The file is for the 2026-27 season. Each August, change `2026-27` in the URL to the new season.

## 3. Add the source and the competition name

```bash
pnpm --filter @vamos/scraper-app cli sources upsert --file docs/scraper-plan/data/source-openfootball-en1.json
```

```bash
pnpm --filter @vamos/scraper-app cli aliases import --file docs/scraper-plan/data/aliases-openfootball-en1.csv
```

The source starts **disabled**. The alias teaches the scraper that "English Premier League" is our
`premier-league`. The club names (for example "Arsenal FC", "Manchester City FC") already match the catalogue
without an alias.

## 4. Start everything

```bash
pnpm dev:all
```

```bash
pnpm --filter @vamos/scraper-app dev
```

The first starts the API (:4000), the worker, the player site (:3000) and the back office (:3001). The second
starts the scraper.

## 5. Switch the source and the competition on (back office)

Open http://localhost:3001. Sign in as the demo **admin**:

- email `admin@demo.vamos.test`, password `vamos-demo-staff`
- the 6-digit code comes from an authenticator app. Add the key `OZQW233TFVSGK3LPFVZXIYLGMYWW65DQ` by hand
  (time-based, 6 digits, 30 seconds). These demo accounts exist only in demo mode.

Go to **Feed**:

1. Press **Enable** on `openfootball-en1`.
2. In **Competitions**, switch **Premier League** to **enabled**. Leave `auto_open`, `auto_results` and
   `extra_time` off. Only the admin role may turn flags on.

Within a minute or two the scraper reads the file and creates events for the games in the next few weeks.
In October 2026 that was **15 events**, each with prices and **betting closed**. Five more games in that
period waited because they involve clubs that are not in the catalogue (see the end of this page).

## 6. Review the ratings so betting can open

Each new event has an open item "ratings uncalibrated". The catalogue's starting ratings count as unreviewed.
Mark them as reviewed with the values below (the seed's starting values; a trader would use their own):

```bash
while IFS='|' read -r team attack defence; do
  pnpm --filter @vamos/scraper-app cli ratings set --team "$team" --attack "$attack" --defence "$defence"
done <<'EOF'
Arsenal|1.5|0.68
Aston Villa|1.22|0.95
Bournemouth|1.1|1.02
Brentford|1.1|1.08
Brighton|1.15|1.0
Chelsea|1.35|0.85
Crystal Palace|1.05|0.95
Everton|0.92|1.0
Fulham|1.02|1.02
Leeds|0.9|1.12
Liverpool|1.55|0.75
Man City|1.52|0.78
Man Utd|1.12|1.0
Newcastle|1.25|0.88
Nott'm Forest|1.05|0.95
Sunderland|0.85|1.15
Tottenham|1.2|1.02
EOF
```

(On Windows, run this in WSL or Git Bash.) After the scraper's next pass (about a minute) the
"uncalibrated" items close by themselves and a new item appears for each event: **"Betting is closed until a
trader approves the odds"**.

## 7. Open betting (trader)

In **Feed → Review**, filter by kind **odds approval**, open an item, check the prices, press **Open betting**.
Do it for a few games. (The trader account `trader@demo.vamos.test` has the same password and key.)

## 8. See them as a player

Open http://localhost:3000, football, **Upcoming**: the Premier League games with their odds. The same list is
at http://localhost:4000/events?filter=upcoming. "Upcoming" shows games that start within the next 72 hours,
so only some of the 15 are listed at first (7 were, in the test run); the rest appear as their kickoff gets
closer.

## Known gaps in this walk-through

- **Three clubs are missing from the catalogue.** Coventry City, Hull City and Ipswich Town came up for 2026-27.
  Games involving them wait with an "unknown team" item; the back office can map a name to an existing team
  but cannot create a team. Adding a club is a change to `packages/db/src/seed/catalog.ts`.
- Relegated clubs (Burnley, West Ham, Wolves) stay in the catalogue; they simply have no games in this file.

## Match results

Results arrive the same way fixtures do: when a match has been played **and** the dataset has its score, the
scraper stores it. With one source it opens a **result unverified** item (Feed → Review). A trader opens it,
checks the score against an official site, and presses **Apply this result**; the confirm step repeats the
score, and the request carries no score at all. The scraper then checks again that no source disagrees and
settles the event, and the worker settles the bets.

Real matches finish on their own schedule, so you can only watch a real result after the games on your
list have been played and the dataset has been updated (for the games of 31 October to 2 November, in the
following days).
