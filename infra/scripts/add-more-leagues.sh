#!/usr/bin/env bash
# Adds the EFL Championship, Eredivisie, Primeira Liga and Brasileirao Serie A to a compose
# deployment that already has the top leagues (infra/scripts/use-football-data.sh, then
# add-top-leagues.sh; infra/scripts/use-odds-api.sh first if The Odds API is wanted):
#
#   infra/scripts/add-more-leagues.sh
#
# 1. Rebuilds the migrate (catalogue) and scraper images and restarts the stack.
# 2. Seeds the new competitions and the clubs the catalogue did not have, and imports the
#    openfootball spellings the name matching does not already map.
# 3. Per league: dry-fetch of the real football-data.org API (a league that fails is skipped),
#    the football-data source, and the clubs' ratings learned from this season's finished
#    matches (`ratings backfill`), so prices start from real form and the clubs count as
#    calibrated. Also the openfootball source (fixtures, no key) and, when The Odds API key
#    is in infra/.env.prod, its prices and final-scores sources (a dry-fetch costs 2 credits
#    each). Every source is added DISABLED.
# football-data.org's and The Odds API's club spellings are not imported: a spelling the
# catalogue does not match reaches the back office as an "unknown team" review item.
# Enabling the sources and competitions and opening betting stay a person's decision.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod
ENV_FILE=infra/.env.prod
VAR=SCRAPER_SECRET_FOOTBALL_DATA
ODDS_VAR=SCRAPER_SECRET_THEODDSAPI
# key, football-data.org competition code, catalogue slug
LEAGUES=("en2 ELC championship" "nl1 DED eredivisie" "pt1 PPL primeira-liga" "br1 BSA brasileirao-serie-a")

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

echo "==> New competitions and clubs"
docker compose run --rm -T migrate node dist/ops/seed.js </dev/null

echo "==> openfootball club spellings"
cli aliases import --file /in/aliases-openfootball-more-leagues.csv

odds=false
if grep -q "^${ODDS_VAR}=." "$ENV_FILE"; then
  odds=true
else
  echo "No $ODDS_VAR in $ENV_FILE: The Odds API sources are skipped (infra/scripts/use-odds-api.sh stores the key)."
fi

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
  # Fixtures and kickoff times from openfootball: a plain file on GitHub, no key, no limit.
  cli sources upsert --file "/in/source-openfootball-$key.json"
  if $odds; then
    for source in "theoddsapi-$key" "theoddsapi-scores-$key"; do
      echo "==> $slug: $source (reading The Odds API once, 2 credits; nothing is written)"
      if cli dry-fetch --source-file "/in/source-$source.json" --limit 3; then
        cli sources upsert --file "/in/source-$source.json"
      else
        skipped+=("$slug: $source (dry-fetch failed, not added)")
      fi
    done
  fi

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
 1. Feed: Enable footballdata-en2, footballdata-nl1, footballdata-pt1 and footballdata-br1, and
    openfootball-en2, -nl1, -pt1 and -br1. If The Odds API sources were added, enable
    theoddsapi-<key> and theoddsapi-scores-<key> for the same four keys. They use API credits,
    so enable them per league as the plan allows (docs/theoddsapi-plan/README.md).
 2. Feed, Competitions: switch EFL Championship, Eredivisie, Primeira Liga and Brasileirao
    Serie A to enabled. Optional, and left to the owner: auto open, so each match opens by
    itself once its kickoff is confirmed (72 hours before, unchanged for 24 hours) and its
    prices pass the checks. With The Odds API on, set pricing to "market" and "auto results" on.
 3. Feed, Review: club names from football-data.org or The Odds API that the catalogue does
    not match appear as "unknown team" items; map each to its club once, later runs resolve it.
 4. Within a few minutes the next 14 days of matches appear with betting closed; without auto
    open, Feed -> Review, kind "odds approval": check the prices and press Open betting.
EOF
