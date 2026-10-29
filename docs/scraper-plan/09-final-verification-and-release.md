# 09. Final verification and release

|            |                                                     |
| ---------- | --------------------------------------------------- |
| Status     | Not started                                         |
| Owner      | the orchestrating session, with a person's sign-off |
| Size       | about 100k tokens plus CI time                      |
| Depends on | every task marked "blocks go-live" in the index     |

## Commands (from the repository root)

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check          # one pre-existing warning: packages/core/src/common-passwords.ts
pnpm test                  # every package; needs Postgres 16 and Redis (pnpm services:start)
pnpm --filter @vamos/scraper-app build
pnpm e2e                   # Playwright, against the dev stack (optional for the scraper)
```

Expected counts at the time of writing: `@vamos/scraper` 424, `@vamos/db` 605,
`@vamos/feed` 168, `@vamos/scraper-app` 22; the admin, API and contract suites
grow with tasks 02 and 03.

## Checks specific to the scraper

1. **Migration path**: a database at migration 0032 reaches 0034 cleanly
   (`pnpm db:migrate`), and `drizzle-kit generate` reports no schema changes.
2. **Smoke test**: start the process with `FEED_PROVIDER=scraped` against a
   migrated database; `/health` and `/ready` answer `ok`.
3. **No dangerous capability**: search `apps/scraper`, `packages/scraper` and
   `apps/api/src/modules/admin/feed.ts` for any call to `voidMarket`,
   `voidSelection` or `resultEvent` with a status other than `finished`
   (`cancelled`, `abandoned`, `postponed`). There must be none.
4. **Only one result path**: `applyConfirmedResult` is the only caller of
   `resultEvent` in `apps/scraper`.
5. **Licensed guard**: with `OPERATING_MODE=licensed` and `FEED_PROVIDER=scraped`
   the process refuses to start without an absolute `SCRAPER_ARCHIVE_DIR`, a
   `SCRAPER_CONTACT` and `SCRAPER_ROBOTS=enforce` (config tests cover it).
6. **Secrets and personal data**: grep the logs of a test run for the source
   URLs' query strings and for any token; none.
7. **Backups**: run the backup test and a restore drill that includes the
   archive volume (task 04).
8. **Docs**: every link in `docs/scraper.md`, `docs/scraper-plan/*` and the new
   runbooks resolves.

## Release

- Update [../scraper-status.md](../scraper-status.md) to "complete" or list what
  is knowingly left.
- Commit in logical commits on the feature branch and push.
- Tag a version only when asked. (An earlier tag push, `v0.1.0`, was refused by
  the remote in the agent's session; the person can create it from their own
  clone or the Releases page.)
- Open a pull request only when asked, with a description that links
  `docs/scraper.md` and this folder.

## Go-live checklist (all must be true)

- [ ] Task 01: no open critical or high finding.
- [ ] Tasks 02, 03, 04 done and verified; task 05 done or consciously skipped.
- [ ] At least two sources with different upstreams, terms recorded.
- [ ] Shadow scorecard met for the last two weeks (task 07).
- [ ] Teams, aliases and starting ratings seeded; a trader has reviewed prices.
- [ ] The competition goes live with `auto_open` and `auto_results` off.
- [ ] Alerting exists for `broken`/`blocked` sources and old open review items.
- [ ] A person has signed off the legal position of using each source's data.
