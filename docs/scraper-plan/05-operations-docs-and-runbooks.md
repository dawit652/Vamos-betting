# 05. Operations guide and runbooks

|                |                                                       |
| -------------- | ----------------------------------------------------- |
| Status         | Not started                                           |
| Model / effort | Haiku, low (a person reviews it)                      |
| Size           | about 80k tokens                                      |
| Depends on     | tasks 02, 03 and 04 (so the text matches what exists) |
| Blocks         | recommended before go-live                            |

## Goal

Make the scraper operable by someone who did not build it.

## Files to write

1. `docs/scraper-operations.md`
   - what runs (the three tasks, their intervals, the Redis locks), the settings
     table (copy from `docs/scraper.md` section 7), where logs and health are;
   - the daily check (back-office overview: no `broken` or `blocked` source, no
     old open `unknown_team`, queue sizes) and the weekly check (parse-yield
     trend, agreement rate, archive size);
   - the kill switches (source, competition) and what each does;
   - how results get applied: automatic versus a person (`result_ready`),
     what "unverified" means, how corrections are handled (never automatically);
   - evidence and retention: what is kept, for how long, how it is backed up.
2. `docs/runbooks/feed-source-broken.md`: a source shows `broken` or `blocked`
   (read the run issues, compare the saved snapshot with the last good one in
   the archive, update the adapter config or the golden fixture, re-run, what
   not to do: never lower the shape threshold to make a run pass, never work
   around a block).
3. `docs/runbooks/feed-result-disputed.md`: `result_conflict`,
   `result_correction`, `result_unverified`: how to check the real score
   (official source, a second provider), who decides, what a correction reverses,
   how to record the decision and the evidence.
4. `docs/runbooks/feed-new-source.md`: the onboarding checklist (terms and
   robots read, upstream written down and shown to differ from the other
   source, allowed hosts, dry-run with the CLI from task 07, golden fixture
   added, source enabled in shadow mode first).
5. Update `docs/runbooks/README.md` (table), `docs/deployment.md` (link),
   `docs/architecture.md` (one line and the diagram) and the root `README.md`
   layout table.

CLAUDE.md is the project's instruction file: **propose** these two lines to a
person instead of editing it: "Scraper: results reach `resultEvent` only through
the gates; no code path may cancel, void or abandon an event from scraped data"
and "see docs/scraper.md".

## Acceptance

- Every command and path in the new text exists or is marked as pending.
- Links resolve; Prettier clean.
- A person who has not seen the code can follow the new-source checklist.

## Prompt to start it

> Read `docs/scraper-plan/05-operations-docs-and-runbooks.md`, `docs/scraper.md`
> and the existing runbooks in `docs/runbooks/`; write the files described, in
> the same tone and structure as the existing runbooks. Do not commit.
