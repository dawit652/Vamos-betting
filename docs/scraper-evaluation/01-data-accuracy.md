# Scraper evaluation 01: data accuracy and match-result correctness

Evaluated on 2026-10-29 (fetch time fixed at 2026-10-29T20:45:00Z in every script), branch `claude/busy-rubin-1shjt6`.
Method: the real adapter (`createAdapter`, envelope `docs/scraper-plan/data/source-openfootball-en1.json`) and the real
resolver (`buildAliasIndex` / `resolveTeam`) run on real files, compared with an independent upstream (FPL). Nothing in
production code, gates or config was changed. Percentages always carry n.

**Partial results (scope was cut by the coordinator mid-run):** the in-memory catalogue index was not cross-checked
against a seeded Postgres (see "Not done"); the pipeline behaviour for dropped records is derived from rules R1-R6/F5,
not run.

## 1. Summary

| Metric                                                                                | n                                          | Value                                                                                                                               | Target                      | Verdict                      | Severity                |
| ------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------- | ----------------------- |
| Fixtures in one source but not the other (openfootball vs FPL, by home/away)          | 760 (2 x 380)                              | 0 (0.00%)                                                                                                                           | <= 1%                       | PASS                         | -                       |
| Same, as the system sees it (adapter output vs FPL)                                   | 760                                        | 32 absent (4.21%): every bare `[0,0]` record                                                                                        | <= 1%                       | GAP                          | high                    |
| Kickoff UTC exact vs FPL, 2025-26 (complete season)                                   | 380                                        | 380 (100.00%)                                                                                                                       | >= 99.5%                    | PASS                         | -                       |
| Kickoff UTC exact vs FPL, 2026-27 (in progress)                                       | 380                                        | 359 (94.47%); all 21 misses are unplayed (round 10-12)                                                                              | >= 99.5%                    | GAP                          | high                    |
| Kickoff mismatches among finished matches                                             | 440 finished                               | 0                                                                                                                                   | 0 unexplained               | PASS                         | -                       |
| Kickoff exact, fixtures in the next 14 days (what an event created today would carry) | 20                                         | 12 (60.00%); 8 wrong, 6 on another date, 2 where the match starts EARLIER than our kickoff                                          | >= 99.5%                    | GAP                          | high                    |
| Full-time score equality vs FPL on finished matches (adapter results)                 | 398 (353 + 45)                             | 398 (100.00%), 0 mismatches                                                                                                         | 100%                        | PASS                         | -                       |
| Not-yet-played match turned into a result                                             | 398 results; 30 historic snapshots         | 0                                                                                                                                   | 0                           | PASS                         | -                       |
| Parse yield, Premier League 2025-26: rejected records                                 | 380                                        | 27 (7.11%), all `bad_score` on a bare `[0,0]`, all real 0-0 draws (FPL: 27 of 27)                                                   | <= 1%, none hiding a result | GAP                          | high                    |
| Parse yield, Premier League 2026-27                                                   | 380                                        | 5 (1.32%), same cause, 5 of 5 real 0-0 (FPL)                                                                                        | <= 1%, none hiding a result | GAP                          | high                    |
| Parse yield, 2025-26, other seeded leagues (rejected / records)                       | es 15/380, it 36/380, de 12/306, fr 23/306 | 3.9% / 9.5% / 3.9% / 7.5%, all bare `[0,0]`                                                                                         | <= 1%                       | GAP                          | high                    |
| Half-time score present on results (Premier League)                                   | 398                                        | 398 (100%), HT never above FT; HT cannot be verified (FPL has none)                                                                 | report                      | UNKNOWN (value), PASS (form) | low                     |
| `scoreBasis` emitted                                                                  | 398                                        | `regular_time` 398 (100%); no `et`/`p` in any seeded league file                                                                    | regular_time only           | PASS                         | -                       |
| Name resolution without alias: Premier League                                         | 23 clubs                                   | 23 (100%) at catalogue `049cbdf`                                                                                                    | >= 98%                      | PASS                         | -                       |
| Name resolution without alias: LaLiga                                                 | 14 clubs in catalogue                      | 9 (64.3%)                                                                                                                           | >= 98%                      | GAP                          | high                    |
| Name resolution without alias: Serie A                                                | 13                                         | 10 (76.9%)                                                                                                                          | >= 98%                      | GAP                          | high                    |
| Name resolution without alias: Bundesliga                                             | 13                                         | 12 (92.3%)                                                                                                                          | >= 98%                      | GAP                          | medium                  |
| Name resolution without alias: Ligue 1                                                | 13                                         | 10 (76.9%)                                                                                                                          | >= 98%                      | GAP                          | high                    |
| Wrong team matches (source name resolves to another club)                             | 110 seeded-league names + 174 other clubs  | 0                                                                                                                                   | exactly 0                   | PASS                         | -                       |
| Collisions: two source names to one team; exact normalised-name collision             | 116 football teams, 214 name forms         | 0 and 0; 0 of 2,782 mechanical variants reach another team; 50 real-world spellings probes: 0 wrong                                 | 0                           | PASS                         | -                       |
| Latent wrong-match hazards (alias file, suggestions)                                  | see section 3.5                            | `costa-rica-aliases.csv` is global; 18 of 34 unresolved non-catalogue clubs get a wrong top-1 suggestion                            | 0                           | GAP                          | medium (latent)         |
| Coverage next 21 days: Premier League                                                 | 20 fixtures                                | 20 would become events (100%)                                                                                                       | report                      | PASS                         | -                       |
| Coverage next 21 days: Serie A / Bundesliga / Ligue 1 / LaLiga                        | 20 / 18 / 18 / 20 with time                | 5 (25%) / 5 (27.8%) / 4 (22.2%) / 0 (0%: all 20 have no kickoff time in the file)                                                   | report                      | GAP                          | high                    |
| Time handling: midnight placeholders, non-HH:MM, impossible dates, DST                | 19 league files; 760 PL matches            | 0 / 0 / 0; DST: all 760 exact incl. 10 matches within 3 days of 25 Oct 2026                                                         | 0                           | PASS                         | -                       |
| Source freshness / format stability (extra)                                           | 22 + 8 historic snapshots                  | HEAD is 37 days old; 1 invalid-JSON commit, 1 commit with no dates (0/380 accepted), 5 matches with a wrong score for up to 6 weeks | report                      | GAP                          | high (see gaps 2, 5, 6) |

## 2. Method

- **Data** (all under the scratchpad `eval-data/data-eval`, never executed): openfootball `football.json`
  `master` HEAD `e6744429ee395bc86f247348c6184bb08d4eb361` (2026-09-22) files `2025-26` and `2026-27` for `en.1 es.1 de.1 it.1 fr.1`
  plus `en.2 en.3 pt.1 nl.1 at.1 tr.1`; FPL (vaastav/Fantasy-Premier-League) HEAD
  `d7b05b51d137bfefef4b692386d18c610975b9b9` (2026-10-22, "Fpl data gw6") `fixtures.csv` and `teams.csv`. Full git history of
  the two openfootball `en.1.json` files was cloned (blobless) for section 3.7: 22 and 8 commits.
- **Catalogue**: `packages/db/src/seed/catalog.ts` at `049cbdf` (adds Coventry, Hull, Ipswich; the branch moved from
  `439bee1` while this evaluation ran). The index is built in memory the way `loadAliasInputs` does (name values + short name, no aliases),
  with the pipeline's own `buildAliasIndex` and `resolveTeam`.
- **Scripts** (`apps/scraper/src/eval/`, run from the repo root with `pnpm --filter @vamos/scraper-app exec tsx src/eval/<file>.ts`;
  they pass eslint, prettier and typecheck):
  - `data-fpl.ts --data <dir> --out <json> --now <ISO>`: measurements 1, 2, 3, 6 against FPL.
  - `data-leagues.ts --data <dir> --out <json> --now <ISO>`: yield, score shapes, time shapes for every league file.
  - `data-names.ts --data <dir> --out <json> --now <ISO>`: name resolution, collision test, coverage.
  - `data-history.ts --dir <snapshots> --season <s> --fpl-dir <dir> --out <json>`: replays every historic commit through the adapter.
  - `data-lib.ts`: shared helpers (CSV reader, adapter builder, the FPL-to-openfootball name table).
- **FPL name map** (explicit, 23 names; FPL -> openfootball): Man City -> Manchester City FC, Man Utd -> Manchester United FC,
  Spurs -> Tottenham Hotspur FC, Wolves -> Wolverhampton Wanderers FC, Nott'm Forest -> Nottingham Forest FC,
  Newcastle -> Newcastle United FC, Leeds -> Leeds United FC, Brighton -> Brighton & Hove Albion FC, Bournemouth -> AFC Bournemouth,
  West Ham -> West Ham United FC, Sunderland -> Sunderland AFC, Hull City -> Hull City AFC, Coventry City -> Coventry City FC,
  Ipswich Town -> Ipswich Town FC; Arsenal, Aston Villa, Brentford, Burnley, Chelsea, Crystal Palace, Everton, Fulham, Liverpool
  get ` FC` appended. The script fails if an FPL team has no entry; all 380 + 380 pairs matched on (home, away), no duplicates.
- Output summary: `docs/scraper-evaluation/data/01-data-accuracy.json`.

## 3. Results

### 3.1 Fixtures and kickoffs vs FPL (measurement 1)

| Season  | In both | Only openfootball | Only FPL | Adapter kept | Kickoff exact | Differences (minutes, ours minus FPL)                                                  |
| ------- | ------- | ----------------- | -------- | ------------ | ------------- | -------------------------------------------------------------------------------------- |
| 2025-26 | 380     | 0                 | 0        | 353          | 380 (100%)    | 0: 380                                                                                 |
| 2026-27 | 380     | 0                 | 0        | 375          | 359 (94.47%)  | 0: 359; +/-150: 5; +1140: 2; -1260: 1; -1380: 5; -1385: 4; -1530: 3; -3180: 1 (n = 21) |

The kickoff of the five dropped 2026-27 records, converted directly with `zonedToUtc`, also equals FPL, as does the adapter
output (adapter vs direct conversion: 0 differences). DST: openfootball's local times plus `Europe/London` match FPL for
every match of the 2025-26 season (spans 26 Oct 2025 and 29 Mar 2026); around 25 Oct 2026, 10 matches (5 before, 5 after the change) are exact;
no match falls within 3 days of 29 Mar 2026 (international break).

**All 21 mismatches (2026-27, all unplayed, FPL has the later TV-selection time; openfootball still shows the Saturday 15:00 placeholder).**
Rounds 10-12; format: match, openfootball local, FPL UTC (equals London local in November).

| Round | Match                               | Ours (openfootball) | FPL          | Diff (min) |
| ----- | ----------------------------------- | ------------------- | ------------ | ---------- |
| 10    | Nottingham Forest v Manchester City | 07 Nov 15:00        | 07 Nov 17:30 | -150       |
| 10    | Leeds United v Tottenham Hotspur    | 07 Nov 15:00        | 07 Nov 12:30 | +150       |
| 10    | Everton v Coventry City             | 07 Nov 15:00        | 06 Nov 20:00 | +1140      |
| 10    | Crystal Palace v Liverpool          | 07 Nov 15:00        | 08 Nov 14:00 | -1380      |
| 10    | Sunderland v Chelsea                | 07 Nov 15:00        | 08 Nov 14:00 | -1380      |
| 10    | Ipswich Town v Bournemouth          | 07 Nov 15:00        | 08 Nov 14:00 | -1380      |
| 10    | Brighton v Brentford                | 07 Nov 15:00        | 08 Nov 14:00 | -1380      |
| 10    | Manchester United v Aston Villa     | 07 Nov 15:00        | 08 Nov 16:30 | -1530      |
| 11    | Manchester City v Fulham            | 21 Nov 15:00        | 21 Nov 12:30 | +150       |
| 11    | Liverpool v Manchester United       | 21 Nov 15:00        | 22 Nov 16:30 | -1530      |
| 11    | Hull City v Brighton                | 21 Nov 15:00        | 22 Nov 14:00 | -1380      |
| 11    | Brentford v Everton                 | 21 Nov 15:00        | 23 Nov 20:00 | -3180      |
| 11    | Newcastle United v Arsenal          | 21 Nov 15:00        | 21 Nov 17:30 | -150       |
| 12    | Ipswich Town v Aston Villa          | 28 Nov 15:00        | 28 Nov 17:30 | -150       |
| 12    | Arsenal v Manchester City           | 28 Nov 15:00        | 29 Nov 16:30 | -1530      |
| 12    | Everton v Liverpool                 | 28 Nov 15:00        | 29 Nov 12:00 | -1260      |
| 12    | Fulham v Bournemouth                | 28 Nov 15:00        | 29 Nov 14:05 | -1385      |
| 12    | Nottingham Forest v Chelsea         | 28 Nov 15:00        | 27 Nov 20:00 | +1140      |
| 12    | Brighton v Newcastle United         | 28 Nov 15:00        | 29 Nov 14:05 | -1385      |
| 12    | Sunderland v Tottenham Hotspur      | 28 Nov 15:00        | 29 Nov 14:05 | -1385      |
| 12    | Crystal Palace v Hull City          | 28 Nov 15:00        | 29 Nov 14:05 | -1385      |

16 of the 21 are on another calendar date. Explanation (evidence, not proof): openfootball's last commit is 2026-09-22 (37 days old at the evaluation);
the history replay (3.7) shows its placeholder 15:00 slots are replaced 4 to 13 days before the match once the broadcaster picks are published, and
FPL carries them already. We cannot tell which of the two is "official" without a third source; FPL is the Premier League's own
fixture feed, so it is treated as the truth here. Rounds 6-9 (matches up to 2 Nov) are all exact.

**Next 14 / 21 days (measured now):** 20 fixtures in both windows (round 9 and 10). 12 exact, 8 wrong (40%), 6 on a different UTC date, 2 where FPL starts
earlier than our kickoff (Everton v Coventry: 20:00 Friday vs our Saturday 15:00, 19 h earlier; Leeds v Tottenham: 12:30 vs 15:00).
With the 14-day horizon (`FIXTURE_HORIZON_MS`) the round-10 events would be created with these wrong times.

### 3.2 Scores and parse yield (measurement 2)

| Season  | FPL finished | Adapter results | Compared | Equal | Mismatch | FPL finished, no adapter result                                                                                                                         |
| ------- | ------------ | --------------- | -------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2025-26 | 380          | 353             | 353      | 353   | 0        | 27 (rejected bare `[0,0]`)                                                                                                                              |
| 2026-27 | 60           | 45              | 45       | 45    | 0        | 15: 5 rejected bare `[0,0]`; 10 played on 10-12 Oct with no score in the file yet (file is stale, last commit 22 Sep, round 5 is its last scored round) |

Full-time mismatches vs FPL: none. No adapter result exists for a match FPL does not call finished (0 of 398), none starts less than
kickoff + 105 min before the fetch time, and no historic snapshot of either season carries a score before the match's kickoff (0).

**Rejected records (parse yield).** Every reject has code `bad_score: score must be an object`, and every one is a bare array `"score": [0, 0]`
(no `ft`/`ht` object). FPL says all of them are real 0-0 draws: 27 of 27 in 2025-26 and 5 of 5 in 2026-27. Over the
two seasons the Premier League has 32 goalless draws and the file spells **every one** of them as the bare pair (0 draws appear as `{"ft":[0,0],...}`).
The docs (`scraper-local-test.md`) call these "matches with a bare `[0, 0]` instead of a proper score ... the scraper refuses to guess";
the measurement shows they are not unknown scores, they are the dataset's normal encoding of a goalless draw. So the adapter drops 100% of 0-0 results.
Other leagues, 2025-26 (rejected / records): La Liga 15/380 (3.95%), Serie A 36/380 (9.47%), Bundesliga 12/306 (3.92%), Ligue 1 23/306 (7.52%); all `[0,0]`.
In third-tier files (`en.3`) bare pairs also carry non-zero scores (95 records, e.g. `[2,1]`), so the encoding is "full time without half time" in general.
Records with a real `score: null`/missing score are accepted as scheduled fixtures; no reject hides a non-0-0 result.

### 3.3 Half time and score basis (measurement 3)

Premier League results: 398 of 398 carry an HT score (353 + 45), HT never exceeds FT, `scoreBasis` is `regular_time` for all, status `finished` for all. HT cannot
be checked against FPL (no HT in its data), so HT correctness is UNKNOWN. Knockout-style records do not occur in the five seeded league files
(`et`/`p` keys: 0). One occurs in the unseeded `en.2` 2025-26 file: a play-off `{"et":[1,0],"ft":[0,0]}` (Southampton v Middlesbrough, 2026-05-12); the adapter takes `ft` as
`regular_time` (0-0), which is the 90-minute score, and would use basis `unknown` only for a record with `et`/`p` and no `ft`. Without HT those records can never satisfy R2 for an event that needs half time.

### 3.4 Name resolution (measurement 4)

Catalogue at `049cbdf`; "club" = distinct source name across 2025-26 and 2026-27. Truth table (which catalogue team a source club is) is the evaluator's own, in `data-names.ts`.

| League         | Catalogue teams | Source clubs | In catalogue | Resolve without alias | Rate (of in catalogue) | Wrong | Not in catalogue |
| -------------- | --------------- | ------------ | ------------ | --------------------- | ---------------------- | ----- | ---------------- |
| Premier League | 23              | 23           | 23           | 23                    | 100%                   | 0     | 0                |
| LaLiga         | 14              | 23           | 14           | 9                     | 64.3%                  | 0     | 9                |
| Serie A        | 13              | 23           | 13           | 10                    | 76.9%                  | 0     | 10               |
| Bundesliga     | 13              | 21           | 13           | 12                    | 92.3%                  | 0     | 8                |
| Ligue 1        | 13              | 20           | 13           | 10                    | 76.9%                  | 0     | 7                |

(Share of all source clubs that resolve: 100%, 39.1%, 43.5%, 57.1%, 50.0%.) At the previous commit `439bee1` Coventry, Hull and Ipswich were also missing.

**In the catalogue but unresolved without alias (12, all "safe misses", need an alias):** Club Atlético de Madrid -> Atletico Madrid; RC Celta de Vigo -> Celta Vigo;
Rayo Vallecano de Madrid -> Rayo Vallecano; Real Betis Balompié -> Real Betis; Real Sociedad de Fútbol -> Real Sociedad; Atalanta BC -> Atalanta; Bologna FC 1909 -> Bologna;
FC Internazionale Milano -> Inter; TSG 1899 Hoffenheim -> Hoffenheim; Lille OSC -> Lille; Racing Club de Lens -> Lens; Stade Rennais FC 1901 -> Rennes.

**Clubs not in the catalogue (34):** LaLiga: Deportivo Alavés, Elche CF, Levante UD, Málaga CF, RC Deportivo La Coruña, RCD Espanyol de Barcelona, RCD Mallorca, Real Oviedo,
Real Racing Club de Santander. Serie A: AC Monza, AC Pisa 1909, Cagliari Calcio, Frosinone Calcio, Hellas Verona FC, Parma Calcio 1913, US Cremonese, US Lecce, US Sassuolo Calcio, Venezia FC.
Bundesliga: 1. FC Heidenheim 1846, 1. FC Köln, FC Augsburg, FC Schalke 04, FC St. Pauli 1910, Hamburger SV, SC Paderborn 07, SV 07 Elversberg. Ligue 1: Angers SCO, ES Troyes AC, FC Lorient, FC Metz,
Le Havre AC, Le Mans FC, Paris FC.

### 3.5 Wrong-match audit (CRITICAL if any: found none)

- Source names -> catalogue team: 110 seeded-league names, 0 wrong. 174 clubs of six unseeded league files (`en.2 en.3 pt.1 nl.1 at.1 tr.1`, both seasons): 6 resolve, all to the same club
  (Ipswich, Coventry, Hull in `en.2` 2025-26; Wolves, Burnley, West Ham in `en.2` 2026-27), 0 wrong. No two source names resolve to the same team (0).
- Exact collision test over **all 116 football catalogue teams** (214 name forms, includes Costa Rica, Ethiopia, CAF): 0 pairs share a normalised name. 2,782 mechanical variants
  (upper/lower case, accents removed, `&`/`and`, apostrophes, `FC `/` FC`/` CF`/`AFC `/` SC`/` BSC`, dots, double spaces) of every form: 0 resolve to a different team.
- 50 real-world spelling probes (`Inter`, `Inter Milan`, `Internazionale`, `Man United`, `Man City`, `Athletic`, `Atlético`, `Real Madrid/Sociedad/Betis`, `Köln`, `Cologne`, `BVB`, `Mönchengladbach`, `Inter Miami CF`, `Union Saint-Gilloise`,
  `Paris FC`, `Sporting CP`, `Manchester`, `Real`, `United`, ...): 35 correct or correctly unresolved, 15 safe misses (unresolved), **0 wrong**. Examples: `Inter Milan`, `Athletic Bilbao`, `Man United`, `BVB`, `Mönchengladbach` do not resolve (need aliases).
- Exact-only resolution is the reason there are no wrong matches. Hazards that would appear if a loose rule were ever added (not present today): shared first tokens `man`/`manchester` (Man City / Man Utd),
  `real` (Madrid / Betis / Sociedad), `inter` (Inter / Inter San Carlos), `borussia` (Dortmund / Gladbach), `olympique`, `stade`, `club`; token-subset pairs Inter ~ Inter San Carlos and San Carlos ~ Inter San Carlos;
  edit distance <= 2: Leeds ~ Lens, Roma ~ Como, Roma ~ Raja (3 pairs).
- **Latent hazard 1: `docs/scraper-plan/data/costa-rica-aliases.csv`.** All 11 team rows have an empty `source` column, which `aliases import` reads as "every source". Resolution is sport-wide, not competition-scoped, so after that import `Sporting` and `Sporting F.C.`
  resolve to `Sporting CR` for any source (tested). A Portuguese source that writes Sporting Lisbon as plain "Sporting" would be matched to the Costa Rican club.
- **Latent hazard 2: N3 suggestions.** For the 34 clubs outside the catalogue, the top-1 suggestion is a WRONG club for 18 (e.g. Paris FC -> PSG (433/1000), Real Oviedo -> Real Betis, Deportivo Alavés -> Saprissa,
  RCD Espanyol -> Barcelona, 1. FC Köln -> Union Berlin, AC Monza -> AC Milan, Cagliari -> Udinese, ES Troyes AC -> AC Milan). For the 12 clubs that are in the catalogue the top-1 is right 12 of 12. Suggestions are never applied automatically (N3), but one click by a trader on a wrong suggestion creates a wrong alias.
- Competition names: the label in the config is the operator's choice. `English Premier League` (the shipped label) does not resolve without the alias row in `aliases-openfootball-en1.csv`, and none of the file names ("Spain Primera División 2026/27", ...) resolve; labels equal to the catalogue names (Premier League, LaLiga, Serie A, Bundesliga, Ligue 1) do.

### 3.6 Coverage of the next 21 days (measurement 5)

Window (now + 10 min, now + 21 days]; the code's horizon is 14 days, with these fixtures both windows give the same numbers. "Events" assumes the competition label resolves and the policy is enabled (default is off).

| League         | Fixtures in window (file) | Dropped, no kickoff time | Adapter fixtures | Both clubs resolve (events) | Share of adapter fixtures | Blocking clubs (fixtures blocked each)                                                                                                  |
| -------------- | ------------------------- | ------------------------ | ---------------- | --------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Premier League | 20 (FPL: 20)              | 0                        | 20               | 20                          | 100%                      | none (earlier doc run: 15 events, 5 blocked by Coventry/Hull/Ipswich, now in the catalogue)                                             |
| Serie A        | 22                        | 0                        | 20               | 5                           | 25.0%                     | AC Monza, Atalanta BC, Bologna FC 1909, Cagliari, FC Internazionale Milano, Frosinone, Parma, US Lecce, US Sassuolo, Venezia (2 each)   |
| Bundesliga     | 18                        | 0                        | 18               | 5                           | 27.8%                     | 1. FC Köln, FC Augsburg, FC Schalke 04, Hamburger SV, SC Paderborn 07, SV 07 Elversberg, TSG 1899 Hoffenheim (2 each)                   |
| Ligue 1        | 18                        | 0                        | 18               | 4                           | 22.2%                     | Angers SCO, ES Troyes AC, FC Lorient, Le Havre AC, Le Mans FC, Lille OSC, Paris FC, Racing Club de Lens, Stade Rennais FC 1901 (2 each) |
| LaLiga         | 20                        | 20                       | 0                | 0                           | 0% of 20                  | every fixture lacks `time` in the file (`missing_time` warning, record dropped)                                                         |

"Fixtures in window (file)" uses the file's own list (date +/- 12 h); only for the Premier League is there an independent list (FPL), which matches. For the other leagues completeness of the list is UNKNOWN.

### 3.7 Time handling and source history (measurement 6, plus the history replay)

Present-day files: missing `time` in the Premier League 0 of 760; midnight placeholders 0 in all 19 league files; non-HH:MM times 0; impossible calendar dates 0. Other leagues' 2026-27 files have 100-290 records
without a time (future matches), which the adapter drops with a `missing_time` warning and never turns into a fixture (documented behaviour; it is the reason LaLiga has no events now). Local-time slot tables are consistent with local
league time (LaLiga 21:00/18:30/16:15/14:00, Bundesliga 15:30/18:30/20:30, Serie A 20:45/15:00/18:00, Ligue 1 17:15/20:45), so each league needs its own `timeZone`; the shipped envelope has one zone for its whole source.

History replay (each commit that touched `en.1.json` run through the real adapter at its commit time; snapshots are sparse, so figures are lower bounds on exposure):

- **2025-26, 22 commits:** accepted records per snapshot: 0 of 380 at the first (every unplayed match has `"score": {}` -> `bad_score`), 100/380 on 2025-11-04 (73.7% rejected), 186-291 of 380 in Jan-Mar, 370/380 on 2026-05-22, 353/380 final.
  Dated 2025-12-04: **invalid JSON** (a manual commit, "Update match scores for Matchday 12"), fixed 5 days later: the adapter returns fatal `bad_json`. Dated 2026-05-23: records without `round`, `date` and `time`: 0 of 380 accepted (`bad_date`), repaired 3 days later.
  Up to 320 of 380 matches had no kickoff time in the early snapshots (`missing_time`).
- **Wrong scores in the source: 5 of 380 matches (1.3%)** had a score that differs from the final one (FPL agrees with the final): Sunderland v Bournemouth 1-1 (final 3-2), Manchester City v Leeds 3-0 (3-2), Everton v Newcastle 0-0 (1-4),
  Tottenham v Fulham 2-0 (1-2), all of 2025-11-29, present in the snapshots of 2026-01-08, 02-11, 02-12 and 02-14 (about 6 weeks), corrected on 2026-02-19; Aston Villa v Brentford 2-2 (final 0-1, the match date also moved 31 Jan -> 1 Feb 14:00), in 02-11 to 02-14.
  In those snapshots 4/186 (2.2%), 5/249 (2.0%), 5/255, 5/259 scored matches were wrong. A single-source result would have shown a wrong score to a trader; with FPL as a second upstream R3 would have blocked them.
- Kickoff changes inside the file: 50 of 380 matches changed time after a time was first listed (14 of the changes 7-14 days before the match, 1 within 7 days, 13 after the new kickoff date, 25 earlier than 14 days). For fixtures within 14 days of a snapshot,
  the listed kickoff differed from the final one in 4 of 234 fixture-snapshots (1.7%) in 2025-26 and 10 of 133 (7.5%) in 2026-27 (measured against FPL; median error 18-23 h). Sparse snapshots, so a lower bound.
- Score before kickoff: 0 matches in any snapshot of either season carried a score before its kickoff. No unplayed match ever became a result.

## 4. Gaps, ranked

**G1 (high). The adapter drops every 0-0 draw.**
Evidence: 32 of 32 Premier League goalless draws are the bare pair `[0,0]`, rejected `bad_score` (FPL confirms the scores); 3.9-9.5% of all matches in the other four seeded leagues in 2025-26.
Impact: no observation exists for these matches, so R2 and R6 never see a result; by the rules the event stays `scheduled`, the only signal is `fixture_missing` after `MISSING_AFTER_MS` (not run, derived), and bets on Draw/Under/BTTS-No wait for a manual settlement. This fails closed (no wrong payout) but affects about 1 in 14 matches and every goalless draw. It also drives the yield above the 1% bound and into the S1 baseline.
Fix: accept `score: [h, a]` (two non-negative integers) as full time with basis `regular_time` and no half-time; for `[0,0]` the half-time is necessarily 0-0 and can be set. Add the real bare pair to the golden fixtures (a 0-0 from `2025-26/en.1.json`), correct `docs/scraper-local-test.md` and `docs/scraper-operations.md` wording.
Complexity S. Model: sonnet medium.

**G2 (high). Future kickoffs are placeholders; the source is stale.**
Evidence: 8 of 20 Premier League fixtures in the next 14 days have the wrong kickoff (2 start earlier than our event, one by 19 h); 21 of 380 for the season; openfootball HEAD is 37 days old; the history shows Saturday 15:00 placeholders replaced 4-13 days before the match, i.e. inside the 14-day creation horizon.
Impact: an event is created with a start that is up to 53 h wrong; if betting is opened by a trader, it can stay open after the real kickoff (the 2 earlier cases); a later correction goes through F4 and, with one source, opens `kickoff_change` (earlier, or more than 2 h) rather than fixing itself.
Fix: (a) a placeholder guard: do not create or open an event from a single source whose kickoff is a default slot (Saturday 15:00 with no second source) until the match is within the broadcaster-selection window, or require a second upstream to agree on the kickoff (F2 already requires agreement when two sources saw it); (b) a freshness check for sources: alert when the file's last change is older than N days even though the run is "healthy" (S1 is yield-based and cannot see staleness); (c) add a second fixtures upstream for the Premier League (the FPL feed is the one measured here, check its terms first).
Complexity M. Model: sonnet high (gate logic touches F2/F4 rules).

**G3 (high). Name coverage below target in four leagues, and the catalogue is narrow.**
Evidence: 12 clubs in the catalogue need an alias (LaLiga 64.3%, Serie A 76.9%, Ligue 1 76.9%, Bundesliga 92.3%); 34 club names are not in the catalogue; resulting coverage of the next 21 days: Serie A 25%, Bundesliga 27.8%, Ligue 1 22.2%.
Impact: fixtures and results of these clubs stay in `unknown_team` review items; no wrong team is priced.
Fix: ship `aliases-openfootball-<league>.csv` with the 12 mappings (all source-specific `openfootball-*`), and add the 34 clubs with ratings through the seed (needs calibration, rule O1). Also ship the competition aliases for every league source (the Premier League one is in the CSV, `sources upsert` does not import it).
Complexity S for aliases (haiku low or sonnet low), M for the clubs (sonnet medium, ratings need a trader).

**G4 (high for LaLiga). Records without a kickoff time are dropped, and the format of the file is unstable.**
Evidence: all 20 LaLiga fixtures of the next 21 days have no `time`; history: `score: {}` for unplayed matches (73% of records rejected), one invalid-JSON commit, one commit with no dates (0/380). S1 turned each into a fail-closed `broken` run (not run, derived from S1), but the system had no fixtures for those days.
Fix: treat `"score": {}` as "no score" (S); decide what a fixture without time means (publish as `needs time`, never guess); add the replay (`data-history.ts`) as a regression check of any adapter change against the 30 historic snapshots.
Complexity S-M. Model: sonnet medium.

**G5 (medium). The source publishes wrong scores.**
Evidence: 5 of 380 matches carried a wrong score for up to about 6 weeks. Impact: with one upstream a wrong score reaches a trader as `result_unverified`; the design (MIN_INDEPENDENT_SOURCES = 2, R3) is right and this evidence supports not weakening it, and not enabling `auto_results` on a single source.
Fix: a second, independent results upstream before `auto_results`; until then keep the trader check against an official site.
Complexity L (new adapter and terms check). Model: opus high for the gate review, sonnet high for the adapter.

**G6 (medium, latent). Alias file and suggestion hazards.**
Evidence: section 3.5 (`Sporting` global alias; 18 of 34 wrong top-1 suggestions, Paris FC -> PSG).
Fix: write `source` into every row of `costa-rica-aliases.csv` (S); in the review screen show the suggestion score and require both clubs' country or competition to agree, or show no suggestion below 500/1000 (S-M).
Model: sonnet low.

**G7 (low). One time zone per source.** The envelope allows one `timeZone`; a multi-league source would misplace every non-UK kickoff by 1 or 2 hours. Fix: one source per zone, or a zone per request (S, haiku low). No measured error today.

## 5. Limits of this evaluation

- FPL covers the Premier League only; for other leagues kickoffs and scores have **no independent ground truth** (UNKNOWN). Completeness of their fixture lists is also UNKNOWN (the file is the only list).
- The FPL snapshot ends at gameweek 6 (commit 2026-10-22): 60 finished matches in 2026-27; matches of rounds 7-8 (played 17-25 Oct, no score in either source) cannot be judged. FPL values can be provisional (`finished_provisional` is true for all 440 finished matches). FPL data is a third-party mirror of the official API; independence from openfootball is assumed, not proven.
- Which source is right for a future kickoff is not provable without a third source; FPL was taken as the truth.
- Half-time scores cannot be verified (FPL has none). Result lag (speed) is out of scope; the history figures are lower bounds because commits are sparse (22 and 8).
- The truth table of club identities is the evaluator's judgement; "wrong match" counts cover the clubs in these files and the 50 probes, not every possible spelling.
- The catalogue changed during the run (`439bee1` -> `049cbdf`); numbers are for `049cbdf`. The data is a snapshot of 2026-10-29; the file is updated by volunteers, so figures change.

### Not done / how to run later

- Cross-check the in-memory catalogue index against a seeded scratch Postgres (`createdb vamos_eval_data`, `DATABASE_URL=... pnpm db:migrate && pnpm db:seed`, call `loadAliasInputs` + `buildAliasIndex`, compare with `data-names.ts` output). It was skipped when scope was cut; no database was created, nothing to drop.
- Running the dropped-0-0 case through the full pipeline (`apps/scraper` integration test with the real bare pair) to confirm the `fixture_missing` path.
- Refresh: `curl` the files again, re-run the four scripts above with a new `--now`.
