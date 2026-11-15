# 03. Back-office pages

|                |                      |
| -------------- | -------------------- |
| Status         | Not started          |
| Model / effort | Sonnet, medium       |
| Size           | about 250k tokens    |
| Depends on     | task 02 (the routes) |
| Blocks         | task 09              |

## Goal

Give traders and admins a screen for the scraper: see which sources are healthy,
work the review queue, map unknown names and flip the kill switches.

## Pages (in `apps/admin/src/app/feed`)

1. **Overview** (`/feed`): a table of sources (state badge `ok / stale / broken /
blocked / learning / disabled`, last run time and status, records accepted,
   consecutive failures, open items) with an enable/disable button each; queue
   counts per review kind; a competitions table with the policy flags
   (`enabled`, `auto_open`, `auto_results`, `extra_time`). Turning a flag on
   needs `settings.edit`; the page disables the control for roles without it.
2. **Review queue** (`/feed/review`): filters for status and kind, newest
   first, paged by cursor. Severity badge, title, age.
3. **Review item** (`/feed/review/[id]`): the typed payload rendered per kind
   with `parseReviewPayload`:
   - `result_ready`, `result_unverified`: teams, kickoff, the proposed score,
     which sources and upstreams agree and since when, and the **exposure**
     (open bets, total stake). Button "Apply this result" with a confirm step
     that repeats the score; no input field for a score exists.
   - `result_conflict`, `result_correction`: the observations side by side per
     source; no apply button (a person decides in the trading screens).
   - `odds_approval`: the prices summary and a button "Open betting".
   - `unknown_team`, `unknown_competition`: the raw name, the suggestions with
     scores, a picker, and "Map to this team".
   - `kickoff_change`: current and proposed kickoff, sources, whether bets
     exist, "Apply new kickoff".
   - everything else: title, detail, and "Dismiss" with a required note.
4. **Aliases** (`/feed/aliases`): list with filters, create (team or
   competition, raw name, target, optional source), remove.

Add a "Feed" entry to `apps/admin/src/lib/nav.ts` with permission
`trading.view` and update `nav.test.ts` (support and finance roles do not see
it; trader, compliance and admin do, according to `PERMISSION_ROLES`).

## Files

- create `apps/admin/src/app/feed/**`, `apps/admin/src/lib/feed.ts` (pure
  helpers: state labels, score text, age text, payload summaries) and
  `apps/admin/src/lib/feed.test.ts`
- change `apps/admin/src/lib/nav.ts`, `apps/admin/src/lib/nav.test.ts`

Copy the patterns of `apps/admin/src/app/compliance` (`useFetch`, `Badge`,
`DefList`, `Loading`, `Notice`, `PageHeader`, `apiText` and the error helpers).
No new dependencies.

## Acceptance

- Typecheck, lint, format and `pnpm --filter @vamos/admin test` pass.
- Manual check with `pnpm dev:all` against a database with a few review items
  (create them with the db services or `apps/scraper/test/helpers.ts`): every
  page renders, each action calls the right route and shows the server's error.
- No screen can send a score, and "Apply this result" is only offered for open
  `result_ready` and `result_unverified` items.
- Optional, later: a Playwright flow `e2e/tests/feed.spec.ts`.

## Prompt to start it

> Read `docs/scraper-plan/03-admin-pages.md` and the contracts in
> `packages/contracts/src/feed.ts`; build the pages as described, in the style
> of `apps/admin/src/app/compliance`. Do not commit.
