# Odds API fixtures

- `real-*.json`: real responses captured on 3 Nov 2026 around 15:13 UTC with
  `scripts/odds-api/capture-samples.ps1` (region `eu`), each trimmed to two events and to the first 8
  bookmakers per event. `real-sports.json` is the full `/sports?all=true` list (184 keys) rebuilt from the
  script's summary table. They contain no API key.
- `odds-*.json`, `scores-soccer.json`, `sports.json`: hand-made in the documented v4 shape, used by the
  older unit tests.
