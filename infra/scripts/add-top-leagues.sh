#!/usr/bin/env bash
# Adds the Bundesliga, LaLiga, Serie A and Ligue 1 from football-data.org to a compose
# deployment that already has the Premier League source (infra/scripts/use-football-data.sh):
#
#   infra/scripts/add-top-leagues.sh
#
# 1. Rebuilds the migrate (catalogue) and scraper images and restarts the stack.
# 2. Seeds the 26 clubs of 2026-27 the catalogue did not have, imports the competition aliases
#    and the club aliases of football-data.org's spellings.
# 3. Per league: dry-fetch of the real API (a league that fails is skipped), the source (added
#    DISABLED), and the clubs' ratings learned from this season's finished matches
#    (`ratings backfill`), so prices start from real form and the clubs count as calibrated.
# Enabling the sources and competitions and opening betting stay a person's decision.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod
ENV_FILE=infra/.env.prod
VAR=SCRAPER_SECRET_FOOTBALL_DATA
# key, football-data.org competition code, catalogue slug
LEAGUES=("de1 BL1 bundesliga" "es1 PD laliga" "it1 SA serie-a" "fr1 FL1 ligue-1")

[[ -f $ENV_FILE ]] || {
  echo "missing $ENV_FILE: run infra/scripts/init-env.sh first" >&2
  exit 1
}
grep -q '^OPERATING_MODE=demo$' "$ENV_FILE" || {
  echo "refusing: $ENV_FILE is not OPERATING_MODE=demo" >&2
  exit 1
}
token="$(grep "^${VAR}=" "$ENV_FILE" | cut -d= -f2- || true)"
[[ -n $token ]] || {
  echo "no $VAR in $ENV_FILE: run infra/scripts/use-football-data.sh first" >&2
  exit 1
}
command -v python3 >/dev/null || {
  echo "python3 is required: apt-get install -y python3" >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 755 "$WORK" # the scraper container reads the results files as its own user

cli() {
  docker compose run --rm -T --no-deps -v "$PWD/docs/scraper-plan/data:/in:ro" \
    -v "$WORK:/work:ro" scraper node dist/cli.js "$@" </dev/null
}

echo "==> Building the catalogue and the scraper (a few minutes)"
docker compose build migrate scraper
docker compose up -d --wait

echo "==> New clubs"
docker compose run --rm -T migrate node dist/ops/seed.js </dev/null

echo "==> Competition and club aliases"
cli aliases import --file /in/aliases-openfootball-top-leagues.csv
cli aliases import --file /in/aliases-footballdata-top-leagues.csv

added=()
skipped=()
for entry in "${LEAGUES[@]}"; do
  read -r key code slug <<<"$entry"
  echo
  echo "==> $slug: reading the real API once (nothing is written)"
  sleep 7 # football-data.org's free plan allows 10 requests a minute
  if ! cli dry-fetch --source-file "/in/source-footballdata-$key.json" --limit 3; then
    skipped+=("$slug (dry-fetch failed)")
    continue
  fi
  cli sources upsert --file "/in/source-footballdata-$key.json"

  echo "==> $slug: ratings from this season's finished matches"
  sleep 7
  # The token goes to curl on stdin, not on its command line.
  if ! printf 'header = "X-Auth-Token: %s"\n' "$token" |
    curl -fsS -K - "https://api.football-data.org/v4/competitions/$code/matches?status=FINISHED" \
      -o "$WORK/$slug.raw.json"; then
    skipped+=("$slug (results not read; source added, ratings not learned)")
    continue
  fi
  python3 - "$WORK/$slug.raw.json" "$WORK/$slug.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
out = [
    {
        "date": m["utcDate"][:10],
        "home": m["homeTeam"]["name"],
        "away": m["awayTeam"]["name"],
        "homeGoals": m["score"]["fullTime"]["home"],
        "awayGoals": m["score"]["fullTime"]["away"],
    }
    for m in data.get("matches", [])
    if m.get("status") == "FINISHED" and m["score"]["fullTime"]["home"] is not None
]
json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
print(f"    {len(out)} finished matches")
PY
  chmod 644 "$WORK/$slug.json"
  if cli ratings backfill --file "/work/$slug.json" --competition "$slug"; then
    added+=("$slug")
  else
    skipped+=("$slug (source added, ratings refused: see above)")
  fi
done
unset token

echo
echo "Added with ratings: ${added[*]:-none}"
if ((${#skipped[@]} > 0)); then
  printf 'Needs a look: %s\n' "${skipped[@]}"
fi
cat <<'EOF'

In the back office:
 1. Feed: Enable footballdata-de1, footballdata-es1, footballdata-it1 and footballdata-fr1.
 2. Feed, Competitions: switch Bundesliga, LaLiga, Serie A and Ligue 1 to enabled. Optional:
    auto open, so each match opens by itself once its kickoff is confirmed (72 hours before,
    unchanged for 24 hours) and its prices pass the checks.
 3. Within a few minutes the next 14 days of matches appear with betting closed; without auto
    open, Feed -> Review, kind "odds approval": check the prices and press Open betting.
EOF
