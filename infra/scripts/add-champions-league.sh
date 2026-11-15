#!/usr/bin/env bash
# Adds the UEFA Champions League from football-data.org to a compose deployment that already
# has the top leagues (infra/scripts/use-football-data.sh, then add-top-leagues.sh):
#
#   infra/scripts/add-champions-league.sh
#
# 1. Rebuilds the migrate (catalogue) and scraper (per-match score basis) images.
# 2. Seeds the 15 clubs of the 2026-27 league phase the catalogue did not have and imports
#    football-data.org's spellings of the clubs.
# 3. dry-fetch of the real API, then the source (added DISABLED).
# 4. Marks the 15 newcomers' hand-set ratings as reviewed (manual): ratings learned in their
#    own leagues would not compare with the top leagues' clubs.
# Knockout matches can end after extra time or penalties: the source marks those scores, and
# the competition's "extra time" switch keeps every result for a person.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod
ENV_FILE=infra/.env.prod
VAR=SCRAPER_SECRET_FOOTBALL_DATA
SOURCE=/in/source-footballdata-cl.json

[[ -f $ENV_FILE ]] || {
  echo "missing $ENV_FILE: run infra/scripts/init-env.sh first" >&2
  exit 1
}
grep -qE '^OPERATING_MODE=(demo|licensed)$' "$ENV_FILE" || {
  echo "refusing: $ENV_FILE has no OPERATING_MODE=demo or OPERATING_MODE=licensed" >&2
  exit 1
}
grep -q "^${VAR}=." "$ENV_FILE" || {
  echo "no $VAR in $ENV_FILE: run infra/scripts/use-football-data.sh first" >&2
  exit 1
}

cli() {
  docker compose run --rm -T --no-deps -v "$PWD/docs/scraper-plan/data:/in:ro" scraper \
    node dist/cli.js "$@" </dev/null
}

echo "==> Building the catalogue and the scraper (a few minutes)"
docker compose build migrate scraper
docker compose up -d --wait

echo "==> New clubs"
docker compose run --rm -T migrate node dist/ops/seed.js </dev/null

echo "==> Club spellings"
cli aliases import --file /in/aliases-footballdata-top-leagues.csv
cli aliases import --file /in/aliases-footballdata-champions-league.csv

echo "==> Reading the real API once (nothing is written)"
if ! cli dry-fetch --source-file "$SOURCE" --limit 6; then
  echo "dry-fetch failed: the source was not added. The lines above say why." >&2
  exit 1
fi
cli sources upsert --file "$SOURCE"

echo "==> Ratings of the newcomers, marked as reviewed (the catalogue's hand-set values)"
while IFS='|' read -r team attack defence; do
  cli ratings set --team "$team" --attack "$attack" --defence "$defence" >/dev/null
  echo "    $team"
done <<'EOF'
PSV|1.15|0.95
Feyenoord|1.08|0.98
Porto|1.12|0.92
Sporting CP|1.15|0.92
Bodo/Glimt|0.95|1.08
Viking|0.82|1.18
Fenerbahce|1.02|1.0
Galatasaray|1.05|1.0
Club Brugge|1.0|1.0
Slavia Prague|0.92|1.05
AEK Athens|0.88|1.08
Shakhtar Donetsk|0.92|1.08
LASK|0.82|1.15
Slovan Bratislava|0.8|1.2
Sabah|0.75|1.25
EOF

cat <<'EOF'

Done. In the back office:
 1. Feed: Enable footballdata-cl.
 2. Feed, Competitions, UEFA Champions League: enabled, and EXTRA TIME on (every result then
    goes to a person; knockout scores after extra time or penalties are marked). Leave auto
    open OFF: prices between clubs of different leagues deserve a look before betting opens.
 3. Feed -> Review, kind "odds approval": check each match's prices and press Open betting.
    A match with a club of the five leagues needs that league's ratings (add-top-leagues.sh).
 4. After a knockout match that went to extra time or penalties, enter the 90-minute score
    in Trading (the item "score basis unknown" points to it).
EOF
