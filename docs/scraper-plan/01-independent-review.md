# 01. Independent review and fixes

|                |                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| Status         | Not started (an earlier attempt was cancelled before producing a report)                                |
| Model / effort | review: Opus, high (a different model from the writers; Fable needs usage credits). Fixes: Sonnet, high |
| Size           | review about 300k tokens; fixes about 100k                                                              |
| Depends on     | –                                                                                                       |
| Blocks         | task 06; any go-live                                                                                    |

## Goal

Find the ways a bad read could still reach money (wrong settlement, wrongly
voided bets, wrong prices opened) or corrupt state, by someone who did not write
the code, and fix what is real.

## Scope

The reviewer reads, runs and reports; it does not change the repository.

- **A. `apps/scraper`**: `pipeline/run-source.ts`, `promote-fixtures.ts`,
  `promote-results.ts`, `common.ts`, `tasks/*`, `lib/*`, `main.ts`, `context.ts`
  and `apps/scraper/test`.
- **B. `packages/db/src/scrape/*`, `schema/scrape.ts`, migrations 0033 and
  0034**: locks, ON CONFLICT, deadlock order, constraints, the append-only
  history and the app-role revoke; whether `listCurrentObservations`,
  `listScrapedEvents`, `getEventExposure` and `lastListedAt` return what the
  rules assume (compare with the real bet statuses in `packages/db/src/betting`
  and the market periods in `packages/core/src/markets.ts`).
- **C. Callers against the gates' contracts** (`packages/scraper/src/gates`
  doc comments): `calibrated`, `pricesSane`, `exposure`, `candidates`, the
  policy of the right competition, `confirmMs`, only current and enabled
  sources, fresh event facts. Any place where a hold or wait is treated as an
  apply, or a decision is applied to a different event than it was computed for.
- **D. Cross-cutting**: any path that changes an event, market, price, bet or
  ledger without a gate decision; anything derived from absence (rule F5);
  double application; work done outside the transaction that belongs inside, or
  published before COMMIT; try/catch blocks that continue in an unsafe state;
  unbounded loops or memory on hostile input; secrets or personal data in logs;
  trust in remote data (names, URLs, config) that could escape the allow-list or
  the archive directory; the staff-confirmation path (can a request or an item
  payload make it apply a score no source currently shows? can an old or
  dismissed item be replayed?).
- **E. Adapters against gates**: kickoff semantics on result pages (the gates
  hold results whose kickoff differs from the event start), `scoreBasis` for
  leagues, time zones, stable source keys when a source has no external ids, the
  openfootball `ft` / `et` / `p` handling.

Also look at the items in [known-limits.md](known-limits.md).

## Deliverable of the review

At most 10 findings, ranked critical / high / medium / low, each with: title,
`file:line`, the concrete failure scenario (inputs and sequence), how it was
confirmed (command and observed result, or "by reading"), and a minimal fix.
Up to five lines on what could not be covered.

## Fix pass

1. Triage the findings with a person: confirmed, plausible, not real.
2. For each confirmed finding add a regression test that fails first, then fix.
3. Severity policy:
   - critical and high: fixed before any competition policy is enabled;
   - medium: fixed before `auto_results` is switched on anywhere;
   - low: backlog (add to [known-limits.md](known-limits.md)).
4. Re-run: `pnpm --filter @vamos/scraper test`, `pnpm --filter @vamos/db test`,
   `pnpm --filter @vamos/scraper-app test`, typecheck, lint, format for the
   touched files.

## Acceptance

- Every critical and high finding is fixed with a regression test, or
  explicitly accepted in writing by a person with the reason.
- The report and the triage are saved as `docs/scraper-plan/review-2026-10.md`
  (or the date of the review).

## Prompt to start it

> Read `docs/scraper-plan/01-independent-review.md` and `docs/scraper.md`, then
> carry out the review exactly as described. Do not modify repository files; put
> throwaway scripts in the scratchpad. Report in the format above.
