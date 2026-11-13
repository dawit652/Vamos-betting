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
- `apifootball-fixtures-bydate.synthetic.json`: SYNTHETIC, hand-written from the documented shape of API-Football v3
  `GET /fixtures?date=2026-11-13&timezone=UTC` (no real response was captured: no working key). Team, league and
  match ids and every score are invented; kickoffs are 2026-11-12 to 2026-11-14 around 12:00 UTC. One item per
  status family (FT, NS, 1H, HT, AET, PEN, PST, CANC, ABD, AWD, WO), an FT with null goals, an FT whose
  `fulltime` equals `goals`, and a kickoff written with a +03:00 offset. Replace with a real response (key removed)
  when plan check 0.4 runs.
- `theoddsapi-events-epl.synthetic.json`: SYNTHETIC, hand-written from the documented shape of The Odds API v4
  `GET /v4/sports/soccer_epl/events` (the free fixture list: `id`, `sport_key`, `sport_title`, `commence_time`,
  `home_team`, `away_team`; no bookmakers). No real response was captured. Ids and kickoffs are invented (read at
  2026-11-07T10:00:00Z in the tests). Two upcoming matches, one already started, one beyond the 15-day horizon,
  one of another sport key and one with an unreadable `commence_time`. Replace with a real response (key removed)
  when one has been captured with `dry-fetch`.

## API-Football, real (13 Nov 2026)

`apifootball-fixtures-bydate.real.json` (one fixture per status from a real worldwide by-date
answer, envelope kept), `apifootball-events-shootout.real.json` (Oakleigh Cannons v Marconi
Stallions, decided on penalties: shoot-out kicks are "Goal" events at elapsed 120 with the comment
"Penalty Shootout") and `apifootball-events-owngoal.real.json` (Fenerbahçe v Lille: an own goal is
filed under the team it counts for). Trimmed from real responses read with the Pro plan for plan
checks 0.4 and 0.8; the synthetic file stays for the edge cases real days rarely show.
