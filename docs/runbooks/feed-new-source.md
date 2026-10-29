# Adding a new feed source

Use it to bring a new source (a site, a JSON endpoint or a calendar) into the scraper, from the first look to
shadow mode. A source starts **disabled**, and nothing it says changes the catalogue until a person has checked
its terms, its upstream and its dry runs and switched it on. The design is in [`scraper.md`](../scraper.md); the
command line is in its section 12; the decisions that only people make are in
[plan 07](../scraper-plan/07-sources-ratings-and-shadow-mode.md).

Work through the checklist in order. Each step names what it needs and what must be written down.

## 0. Before you start

- [ ] A competition is chosen (one is enough to start). Check it on `/feed`, in the **Competitions** table: a
      competition with no policy row shows all four flags off, which is what shadow mode needs.
- [ ] The commands below run from a checkout of the repository with `pnpm install` done. They read
      `DATABASE_URL` and the operating mode from the environment or from `.env`. The production database is not
      published by the stack, so against production run the same command inside the scraper image instead:
      `docker compose run --rm --no-deps scraper node dist/cli.js <command>`, with each input file mounted
      read-only, for example `-v "$PWD/source.json:/in/source.json:ro"` and `--file /in/source.json` (see
      [scraper.md](../scraper.md#production); `COMPOSE_FILE` and `COMPOSE_ENV_FILES` set as in
      [deployment.md](../deployment.md)). `dry-parse` and `dry-fetch --source-file` need no database.
- [ ] Work in a scratch directory outside the repository (for example `<scratch dir>`), so that no file with a page
      or a config lands in a commit.

## 1. Terms and robots

For each source, a person reads and records:

- [ ] The terms of use: is automated access allowed? If not, stop here. Do not use the source.
- [ ] `robots.txt` on every host the source uses. The scraper obeys it (`SCRAPER_ROBOTS=enforce` is the only
      value licensed mode accepts).
- [ ] The exact hosts (for the allow-list: no wildcards, no other ports, no credentials in URLs).
- [ ] The decision, the date and the name of the person who decided. The place for this record is the shadow
      scorecard for the competition, `docs/scraper-plan/shadow-scorecard-<competition>.md`, which is **pending**
      (task 07). Until it exists, keep the record in the change ticket and say so there.

## 2. Terms and upstream

- [ ] Write down the **upstream**: who produces the data (the league, the federation, the data company), not who
      publishes it. Two sites that copy one vendor are one upstream. The result rules count upstreams.
- [ ] Check that at least one other source with a **different** upstream exists for the competition. Without
      two independent upstreams no result can be applied (rule R2), so a single source is not enough to go live.

## 3. Save the pages you will test with

- [ ] Save the fixture page (or the JSON) from the source as a file in the scratch directory, with the URL it
      came from and the time you saved it. Use the real document, not a hand-written one.
- [ ] Save at least one page from a different time (a different matchday, or a finished match) so the results
      side is tested too.

## 4. Write the source file

The file has this shape (the columns of `scrape_sources` without `enabled`, which is not allowed in the file):

```json
{
  "id": "<short id, unique, up to 64 characters>",
  "name": "<name for people, up to 200 characters>",
  "adapter": "openfootball | generic-json | generic-html",
  "upstream": "<the upstream written down in step 2>",
  "config": {}
}
```

The `config` follows the schema of the chosen adapter, and nothing else is accepted (the schemas are strict):
`openfootball` (`packages/scraper/src/adapters/openfootball.ts`), `generic-json`
(`packages/scraper/src/adapters/generic-json.ts`) and `generic-html`
(`packages/scraper/src/adapters/generic-html.ts`). Each has `allowedHosts`, `requests` (URL and purpose), the
sport, the field paths or selectors, the time zone for local kickoffs, and for a source that gives scores a
status map. The rules that bite:

- a source that gives scores needs a status field with a map; a blank status is `status.default` or the record
  is dropped; `default: finished` is refused (a score never makes a match finished);
- an ISO kickoff needs an offset; a local kickoff needs an explicit IANA time zone; nothing is guessed;
- a source that gives scores also sets `scoreBasis` (`regular_time`, `includes_extra_time` or `unknown`); it is
  required when a score is configured. Only a regular-time score can settle a bet: any other basis never counts
  towards an agreed result (rule R10).

Every problem is printed by the next two steps. Do not work around one by loosening the config.

## 5. Dry-parse the saved page

No database and no network:

```bash
pnpm --filter @vamos/scraper-app cli dry-parse --source-file <scratch dir>/source.json --document <scratch dir>/page.html --url '<page url>' --at '<time you saved it, ISO>'
```

Options: `--content-type`, `--limit <n>`. Check the observations: names, kickoffs, competition, status and
score, and the issues. Expect no issue on a correct page; a `fatal` issue means the page is not the one the
config describes. Repeat with the second saved page.

## 6. Dry-fetch the live pages

This fetches through the polite fetcher (allow-list, robots.txt, rate limit) and parses. It writes nothing:

```bash
pnpm --filter @vamos/scraper-app cli dry-fetch --source-file <scratch dir>/source.json --limit 3
```

Expect the same kind of output as step 5 for the live pages. A refused host or a robots refusal is a stop: go
back to step 1.

## 7. Aliases

The source's spelling of each team and competition has to map to the catalogue, by exact match (rule N2).
Write `aliases.csv` with this header and one row per name:

```csv
kind,sport,alias,target,source
team,football,<the source's spelling>,<catalogue team short name>,<source id>
competition,football,<the source's spelling>,<catalogue competition slug>,<source id>
```

- `kind` is `team` or `competition`; `sport` is `football`; `target` is the catalogue team's short name or the
  competition's slug; `source` is the source id (leave it empty or `*` for every source).
- The import is all or nothing: one bad row stops it and nothing is written.

```bash
pnpm --filter @vamos/scraper-app cli aliases import --file <scratch dir>/aliases.csv
```

An alias that already points elsewhere is reported as a conflict. Remove the old one first, then import again:
`aliases list --q <name>` shows its id and `aliases remove --id <id>` removes it (or the **Remove** button on
`/feed/aliases`; see [scraper operations](../scraper-operations.md#5-how-results-reach-the-catalogue)). Names that are still unknown appear on `/feed/review` as `unknown_team` or `unknown_competition` after
the first run; map them there (**Map to this team**, which needs the catalogue id) or add the alias and import again.

## 8. Ratings (only if the teams need prices)

A team's prices come from its ratings, and real bets need at least `SCRAPER_MIN_RATING_MATCHES` matches behind
them (default 8, rule O1). Without ratings the match is created with betting closed and a `ratings_uncalibrated`
item opens. To learn ratings from past results, write `results.json` (an array of
`{ "date": "YYYY-MM-DD", "home", "away", "homeGoals", "awayGoals" }`, regular-time scores, team names as catalogue
short names) and run:

```bash
pnpm --filter @vamos/scraper-app cli ratings backfill --file <scratch dir>/results.json --competition <competition slug> --dry-run
pnpm --filter @vamos/scraper-app cli ratings backfill --file <scratch dir>/results.json --competition <competition slug>
```

Read the `--dry-run` output first: it shows the before and after of each team and every refusal. The backfill
refuses, writing nothing for any team, when a team was set by a trader (`manual = 1`), already learned from more
matches than the file holds, or was backfilled through a later date. Running the same file again changes nothing.

For a team with no history to learn from, a trader sets the ratings by hand (1 is the league average, a higher
`--defence` concedes more, both between 0.35 and 3). Look first, then set; the command prints before and after and
refuses an unknown or ambiguous name:

```bash
pnpm --filter @vamos/scraper-app cli ratings list --team <name>
pnpm --filter @vamos/scraper-app cli ratings set --team <name> --attack 1.2 --defence 0.9 --dry-run
pnpm --filter @vamos/scraper-app cli ratings set --team <name> --attack 1.2 --defence 0.9
```

This sets `manual = 1`: the team counts as calibrated, and a later backfill will not overwrite it.

## 9. Golden fixture

- [ ] Copy the saved page (step 3) into `packages/scraper/src/adapters/__fixtures__/` and add a test for it in the
      adapter's test file, as the existing tests do (`generic.test.ts`). Update the list in that folder's
      `README.md`. Include an edge case that matters for this source (a postponement, a missing status, a time
      change). This is a code change: a pull request, reviewed by an engineer.

## 10. Create the source, disabled

```bash
pnpm --filter @vamos/scraper-app cli sources upsert --file <scratch dir>/source.json
pnpm --filter @vamos/scraper-app cli sources list
```

`sources upsert` runs the runner's own config check and saves the source. A new source is **disabled**, and a
later `upsert` never changes the flag of an existing one. `sources list` shows the state.

## 11. Enable the source in shadow mode

- [ ] Every competition policy stays off (the **Enabled**, **Auto open**, **Auto results** and **Extra time**
      flags on `/feed`). Shadow mode: the scraper stores observations and opens review items, and creates nothing.
- [ ] On `/feed`, switch the source on (**Enable** on its row; `trading.status`). Its first runs appear on the
      row. The first run starts within about 30 seconds (the scheduler checks every 30 seconds and a source with no
      run is due at once); later runs follow the cadence (15 minutes for fixtures).
- [ ] Check every day for two to four weeks, with the scorecard in
      [plan 07](../scraper-plan/07-sources-ratings-and-shadow-mode.md): no unexplained `broken` or `blocked`, no
      unknown names older than seven days, results compared with ground truth, no unexpected audit rows. The
      daily and weekly checks are in [scraper operations](../scraper-operations.md#3-daily-and-weekly-checks).

## 12. Only then: enabling the competition

Each step is one flag on `/feed`, reversible by switching it off, and taken only after the scorecard is met:

1. **Enabled** for the competition, with **Auto open** off: fixtures are created with betting closed. A trader
   opens betting after looking at the prices (`odds_approval`).
2. Results through `result_ready`: a person applies each agreed result.
3. **Auto results**, after weeks of full agreement between the two upstreams.
4. **Auto open** last, and only if the model's prices have been good.

Turning **Enabled**, **Auto open** or **Auto results** on needs `settings.edit` (admin). **Extra time** on means
the scraper never applies a result by itself.

## Afterwards

Record in the change ticket: the source id, its upstream, the terms decision and its date, the dry-run results,
who switched the source on and when, and the scorecard link. The source file and the aliases file stay in the
scratch directory; the fixture and the test are in the repository.
