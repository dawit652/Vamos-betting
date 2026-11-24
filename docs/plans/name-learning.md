# Name learning: mapped names are an asset the system keeps (plan)

Owner, 23 Nov 2026: "the system should hold mapped known names and competitions as an asset, it
should learn, and when a new build is deployed, already mapped teams and competitions must not come
again". The owner said go for all four parts. Build on top of the server's branch: before every
push, `git fetch origin live/nahubet-new-2026-11-15 && git merge-base --is-ancestor FETCH_HEAD HEAD`.

**What was already true:** aliases live in the database, which every deploy keeps (it backs it up
and only adds migrations). Names came back because the back office maps for one source by default,
because a new source spells names its own way, and because removing an alias un-maps on purpose.

## L1. A name mapped once is known from every source (built 23 Nov)

Rule L1 in `docs/scraper.md` 6.4, `packages/scraper/src/normalize/alias.ts` (`learnedTeam`,
`learnedCompetition`): a source-scoped mapping is reused by every other source where the team
already plays (its competition, or one of its country; an international competition needs the
team to have played in it). Not "All sources" by default: a short name such as "Dynamo" means
another club in another country, and the check keeps it apart. The re-resolve pass applies it to
stored rows and closes their items. League names with a provider id ("[39]") are shared as they are.

## L2. Leagues by provider id (built 23 Nov)

A renamed API-Football league keeps its id: an unknown "... [39]" resolves to the competition that
the same upstream mapped under any spelling with that id. Team ids: the stored rows carry no
provider team id, and adding one would change every source's records; API-Football's team names
do not change, and L1 plus N4 cover other spellings. Not built for teams.

## L3. The system keeps learning, with guards (built 23 Nov)

- N4 (fixture context: the opponent and kickoff match a known match) switched on for every source
  (`SCRAPER_AUTO_ALIAS` default `on`), needing two agreeing fixtures before it maps by itself.
- A variant guard (`teamVariantConflict`): never link a name to a reserve (II, B), youth (U17-U23),
  women's (W, Women, Frauen, Femenino...) or national team unless the raw name says so. It filters
  the suggestions people see (N3) and N4's strong candidate. This morning's 11 wrong links were all
  of this kind.
- A daily check (every 6 h, aliases of the last 48 h) lists aliases that break the guard or look like
  another club (a telling word the team's names lack), with one Telegram line a day to the owner
  (`alias_suspicious`). Of the 11 wrong links of 23 Nov, the guard blocks the 6 reserve, women's and
  national ones and the check flags 4 of the other 5; "copenhagen" to "AB Copenhagen" looks like a
  right link to any rule, which is why a person still reads the list.
- A link a person removed is never learned again (N4 already refuses those).

## L4. A file of all mappings, loaded on every deploy (built 23 Nov)

- `aliases export` prints every alias in the columns `aliases import` reads (kind, sport, alias,
  target as a team's short name, unique in its sport, or a competition's slug, source).
- `aliases import --skip-problems` (the deploy's mode) skips a bad row instead of stopping, never
  adds an alias someone removed (audit `scrape.alias.removed`) and never changes an existing alias
  (a different target is a conflict, skipped); a team or competition missing on the server is skipped.
- `infra/scripts/deploy-full.sh`, after the smoke test: the export goes to
  `/root/vamos-backups/aliases/aliases-<time>.csv` on the server, then
  `docs/scraper-plan/data/aliases.csv`, when the repository has it, is imported. A failure only warns.
- To keep the server's mappings in git too: send the newest export to a session, which commits it as
  `docs/scraper-plan/data/aliases.csv` (a new server then starts out knowing every name):

  ```
  ls -t /root/vamos-backups/aliases/ | head -1
  ```
