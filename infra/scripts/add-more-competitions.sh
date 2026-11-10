#!/usr/bin/env bash
# Adds fifteen football competitions to a compose deployment that already has the leagues of
# add-top-leagues.sh and add-more-leagues.sh, with The Odds API as their source
# (infra/scripts/use-odds-api.sh stores the key):
#
#   infra/scripts/add-more-competitions.sh
#
# UEFA Europa League, UEFA Conference League, FA Cup, EFL Cup, EFL League One, EFL League Two,
# Copa del Rey, DFB-Pokal, Coppa Italia, Coupe de France, Saudi Pro League, Süper Lig, Scottish
# Premiership, Belgian Pro League and Swiss Super League.
#
# 1. Rebuilds the migrate (catalogue) and scraper images and restarts the stack.
# 2. Seeds the new competitions and categories and the clubs of Süper Lig, Scottish
#    Premiership, Belgian Pro League, League One and League Two (openfootball 2025-26 lists),
#    and imports the openfootball spellings the name matching does not already map.
# 3. Per competition: dry-fetch of The Odds API (a competition that fails is skipped), then its
#    prices source and its final-scores source, both added DISABLED.
# The Odds API's club spellings are not imported: a spelling the catalogue does not match
# reaches the back office as an "unknown team" review item.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod
ENV_FILE=infra/.env.prod
ODDS_VAR=SCRAPER_SECRET_THEODDSAPI
# key, catalogue slug
COMPETITIONS=(
  "el uefa-europa-league" "ecl uefa-conference-league" "facup fa-cup" "eflcup efl-cup"
  "en3 league-one" "en4 league-two" "cdr copa-del-rey" "dfbpokal dfb-pokal"
  "coppaitalia coppa-italia" "cdf coupe-de-france" "sa1 saudi-pro-league" "tr1 super-lig"
  "sco1 scottish-premiership" "be1 belgian-pro-league" "ch1 swiss-super-league"
)

[[ -f $ENV_FILE ]] || {
  echo "missing $ENV_FILE: run infra/scripts/init-env.sh first" >&2
  exit 1
}
grep -qE '^OPERATING_MODE=(demo|licensed)$' "$ENV_FILE" || {
  echo "refusing: $ENV_FILE has no OPERATING_MODE=demo or OPERATING_MODE=licensed" >&2
  exit 1
}
grep -q "^${ODDS_VAR}=." "$ENV_FILE" || {
  echo "no $ODDS_VAR in $ENV_FILE: run infra/scripts/use-odds-api.sh first" >&2
  exit 1
}

cli() {
  docker compose run --rm -T --no-deps -v "$PWD/docs/scraper-plan/data:/in:ro" \
    scraper node dist/cli.js "$@" </dev/null
}

echo "==> Building the catalogue and the scraper (a few minutes)"
docker compose build migrate scraper
docker compose up -d --wait

echo "==> New competitions and clubs"
docker compose run --rm -T migrate node dist/ops/seed.js </dev/null

echo "==> openfootball club spellings"
cli aliases import --file /in/aliases-openfootball-more-competitions.csv

added=()
skipped=()
for entry in "${COMPETITIONS[@]}"; do
  read -r key slug <<<"$entry"
  echo
  for source in "theoddsapi-$key" "theoddsapi-scores-$key"; do
    echo "==> $slug: $source (reading The Odds API once, 2 credits; nothing is written)"
    if cli dry-fetch --source-file "/in/source-$source.json" --limit 3; then
      cli sources upsert --file "/in/source-$source.json"
      added+=("$source")
    else
      skipped+=("$slug: $source (dry-fetch failed, not added)")
    fi
  done
done

echo
echo "Sources added (disabled): ${added[*]:-none}"
if ((${#skipped[@]} > 0)); then
  printf 'Needs a look: %s\n' "${skipped[@]}"
fi
cat <<'EOF2'

In the back office:
 1. The sources cost The Odds API credits: 2 per read, and the 20,000 monthly credits were
    planned for five leagues (docs/theoddsapi-plan/README.md). Enable only a few at a time
    (Feed, theoddsapi-<key> and theoddsapi-scores-<key>, keys el, ecl, facup, eflcup, en3, en4,
    cdr, dfbpokal, coppaitalia, cdf, sa1, tr1, sco1, be1, ch1) and watch `cli usage` before
    enabling more.
 2. Feed, Competitions: switch the competitions you enabled to enabled. Knockout cups and
    European ties (Europa League, Conference League, FA Cup, EFL Cup, Copa del Rey, DFB-Pokal,
    Coppa Italia, Coupe de France) need the competition's "extra time" switch on: their results
    go to a person.
 3. Feed, Review: clubs the catalogue lacks (Saudi and Swiss clubs, clubs promoted for 2026-27,
    foreign opponents in the cups and European ties) show up as unknown teams: map each to its
    club or add it once, later runs resolve it.
 4. Matches appear with betting closed; Feed -> Review, kind "odds approval": check the prices
    and press Open betting.
EOF2
