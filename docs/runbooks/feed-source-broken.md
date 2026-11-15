# Feed source broken or blocked

Use it when a source on the back office `/feed` page shows state `broken` or `blocked`, or a `source_broken`
review item is open. The states and the daily check are in [scraper operations](../scraper-operations.md#3-daily-and-weekly-checks);
the rules are in [`scraper.md`](../scraper.md) (S1 to S3).

**What the states mean**

- `broken`: the page arrived, but it no longer looks like the page we parse (a fatal parse issue, or fewer
  accepted records than half of the median of the last five successful runs). Nothing from that run was stored,
  so the source's observations are as they were before. The source keeps being retried, with backoff.
- `blocked`: robots.txt refused the path, the response was a block page, or a 429 or 503 carried a block-page
  marker. We back off and wait for the time the site asked for. We never work around it.
- A plain failure (timeouts, 5xx, network errors) is `failed`. It does not show as `broken` or `blocked`: read
  **Failures in a row** on the same `/feed` row.

With `OWNER_ALERT_PHONES` set, a source going `broken` (or `source_stale`) also texts the owner once when its
item opens ([`docs/scraper.md` 6.3a](../scraper.md)); the text is the heads-up, the steps below are what to do.

**Severity:** SEV3. A broken source stops new fixtures and results from that source; it moves no money by
itself. Raise it to SEV2 only if a competition with open bets cannot get its results, because a result needs
two independent upstreams (rule R2).

## 1. Read the state and the reason

Open the source's row on `/feed` (state, last run, failures in a row, open items). Then open the item:
`/feed/review?status=open&kind=source_broken`. Its payload names the source and the reason. Then read the
source's recent runs (read-only):

```bash
docker compose exec postgres psql -U vamos -d vamos -c "select started_at, status, error, issues from scrape_runs where source_id = '<source id>' order by started_at desc limit 5"
```

`issues` lists what the parser or the fetcher reported (a code and, where there is one, a context such as the
URL); `error` is a transport error. A `blocked` run with a `retryAt` in its issues is the time the site asked us
to wait until.

## 2. Compare the saved page with the last good one

The raw archive keeps every page that was fetched. Find the snapshots of the page:

```bash
docker compose exec postgres psql -U vamos -d vamos -c "select id, run_id, url, status, content_hash, bytes, fetched_at, records_seen, records_accepted, keep from scrape_raw where url = '<page url>' order by fetched_at desc limit 10"
```

Pick the newest broken snapshot and the newest snapshot that parsed well (`records_accepted` in line with
its neighbours; a `304` row reuses the hash of the page it refers to). Each archive file is named by its
SHA-256 hash, in two directories of two characters: `<hash 1-2>/<hash 3-4>/<hash>.gz`. Export a copy into an
empty scratch directory **on the production host** (production data stays in production, so do not copy it to
a laptop):

```bash
docker compose exec -T scraper sh -c 'gunzip -c /var/lib/vamos/scraper/<hash 1-2>/<hash 3-4>/<hash>.gz' > <scratch dir>/broken.html
```

The archive checks the bytes against the hash when it reads them; a mismatch is refused, not parsed.

## 3. Reproduce offline

Run the dry commands from a checkout of the deployed commit on the host (`pnpm install` first). They use no
database and write nothing. Use the source file the runner uses (`source.json`, the shape in
[adding a new feed source](feed-new-source.md#4-write-the-source-file)):

```bash
pnpm --filter @vamos/scraper-app cli dry-parse --source-file <scratch dir>/source.json --document <scratch dir>/broken.html --url '<page url>'
pnpm --filter @vamos/scraper-app cli dry-parse --source-file <scratch dir>/source.json --document <scratch dir>/good.html --url '<page url>'
```

Compare the two outputs (observations and issues) and diff the saved pages (`diff good.html broken.html | head -100`).
The production images contain the built CLI as well, but no documented way to run it there exists yet
(**pending**).

## 4. Decide the cause

| What you find                                                                       | Cause                         | Action                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selectors or JSON paths no longer match (the page or API changed)                   | Markup or schema change       | Update the config (section 5)                                                                                                                                         |
| The page moved to another host or path                                              | Allow-list or URL out of date | Add the new host to `allowedHosts` only after its terms are checked again ([new source](feed-new-source.md#2-terms-and-upstream)); until then the source stays broken |
| The page is a block page, a login page or an error page                             | Blocked or unauthorised       | It is `blocked` or `failed`: section 6, not section 5                                                                                                                 |
| The config was saved before a rule existed (for example a score with no status map) | Configuration                 | Fix the config (section 5); such a source stops working until it is fixed                                                                                             |
| The page is genuinely empty (no fixtures this week)                                 | Nothing to parse              | Look at the source's own site; an empty list from `generic-json` is fine, a `generic-html` page with no matching items is fatal                                       |

## 5. Fix the config, never the threshold

1. Edit the source file in the scratch directory.
2. Check it against the broken page and the good one:

   ```bash
   pnpm --filter @vamos/scraper-app cli dry-parse --source-file <scratch dir>/source.json --document <scratch dir>/broken.html --url '<page url>'
   ```

3. Check the live pages without writing anything (it fetches through the polite fetcher: allow-list, robots.txt,
   rate limit):

   ```bash
   pnpm --filter @vamos/scraper-app cli dry-fetch --source-file <scratch dir>/source.json --limit 3
   ```

4. Save it. `sources upsert` runs the same config check as the runner and keeps the enabled flag as it is:

   ```bash
   pnpm --filter @vamos/scraper-app cli sources upsert --file <scratch dir>/source.json
   pnpm --filter @vamos/scraper-app cli sources list
   ```

**Never** lower `SHAPE_MIN_RATIO` or any other constant in `packages/scraper/src/constants.ts` to make a run pass.
A run that is too short is the check doing its job.

## 6. Blocked: back off, do not work around

- **Do not** retry in a loop, change the user agent or the headers, use another address, a proxy, a headless
  browser, a login or a CAPTCHA, or turn `SCRAPER_ROBOTS` off (refused in licensed mode anyway).
- **Do** read the time the site asked for (`retryAt` in the run's issues); the scheduler honours it and will not
  run the source before then.
- **Do** read the site's robots.txt and terms again. If the path is now disallowed, or a block page keeps
  coming back, disable the source (`/feed`, **Disable**) and write down why. Its observations stop voting at
  once.
- **Do** tell the engineer on call and the trader. A licensed data provider can replace the source (the design
  allows one more adapter with its own upstream).

## 7. Re-run and close

There is no "run now" control in the back office or the CLI (**pending**). The next scheduled run tries the
source again: every 15 minutes for fixtures, but while a source has failed runs in a row the interval doubles per
failure, up to six hours. So a fix takes effect at the next due run, which can be hours away. Say so to the
people waiting.

- The `source_broken` item closes itself on the next run that parsed a page.
- A run that only got `304 Not Modified` does not close it (the page has not changed since the bad one). When
  `sources list` shows a healthy last run, dismiss the item on its page with a note that names the fix.

## Afterwards

Record in the incident log ([basics](incident-basics.md)): source id, state, what the run reported, cause, the
change (commit or config), run ids before and after, who. Add the new page to the adapter fixtures
(`packages/scraper/src/adapters/__fixtures__/`, with a test in the adapter's test file) when the markup has
changed for good; that is a code change and goes through a pull request.
