# Adapter fixtures

- `openfootball-en1-sample.json`: a trimmed slice (first 13 matches) of the English Premier League 2024/25 file of
  https://github.com/openfootball/football.json (CC0, public domain). Matches 11-13 had their `score` removed to make
  them unplayed. Three crafted edge cases are appended (not in the real data):
  1. Chelsea v Brighton, 2025-03-30 01:30: a time that does not exist in Europe/London (DST gap) -> `bad_time`.
  2. Everton v Leeds: only `et` and `p` in the score (no `ft`) -> result with `scoreBasis: 'unknown'`.
  3. Aston Villa v Newcastle: `ft` has 3 elements -> dropped with `bad_score`.
- `generic-json-league.json`, `generic-html-league.html`: made-up documents for the configurable adapters.
- `openfootball-en1-2025-26-goalless.json`: two real records (Aston Villa v Newcastle, Chelsea v Crystal Palace, Matchday 1)
  of the 2025/26 English Premier League file, unchanged. The dataset writes a goalless draw as a bare pair `"score": [0, 0]`.
- `footballdata-en1-sample.json`: a made-up document in the shape of football-data.org's v4
  `GET /v4/competitions/PL/matches` response (`matches[*]` with `utcDate`, `status`, `homeTeam.name`,
  `score.fullTime` / `score.halfTime`), for `docs/scraper-plan/data/source-footballdata-en1.json`. The fixtures
  and kickoffs of 6-8 November 2026 are the real ones (official Premier League schedule); every other value is
  invented. Replace it with a real response once one has been captured (`dry-fetch` on the server).
