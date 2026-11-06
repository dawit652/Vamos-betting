#!/usr/bin/env bash
# Sets up The Odds API (docs/theoddsapi-plan/README.md) for the five top leagues on a compose
# deployment that already has their fixtures from football-data.org. Safe to run again: it
# updates what exists and keeps every source's enabled flag.
#
#   infra/scripts/use-odds-api.sh
#
# 1. Asks for the API key (hidden) unless infra/.env.prod has SCRAPER_SECRET_THEODDSAPI, and
#    stores it there (mode 600, never printed).
# 2. Rebuilds the migrate (api) and scraper images and restarts the stack.
# 3. Imports The Odds API's club spellings (aliases-theoddsapi.csv).
# 4. Per league, after one dry-fetch each (2 credits each; nothing is written):
#    - theoddsapi-<league>: bookmaker prices, and the matches as fixtures (a second kickoff
#      upstream: a kickoff both sources agree on moves without a person, rule F4a);
#    - theoddsapi-scores-<league>: final scores (a second result upstream: rule R2), read only
#      after the league's own matches.
#    New sources start DISABLED; a league whose dry-fetch fails is skipped.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod
ENV_FILE=infra/.env.prod
VAR=SCRAPER_SECRET_THEODDSAPI
LEAGUES=(en1 de1 es1 it1 fr1)

[[ -f $ENV_FILE ]] || {
  echo "missing $ENV_FILE: run infra/scripts/init-env.sh first" >&2
  exit 1
}

entered=false
if ! grep -q "^${VAR}=." "$ENV_FILE"; then
  [[ -t 0 ]] || {
    echo "no $VAR in $ENV_FILE and no terminal to ask for it (run with ssh -t)" >&2
    exit 1
  }
  echo "Paste your The Odds API key (it is not shown) and press Enter:"
  IFS= read -rs key
  echo
  key="${key//[[:space:]]/}"
  [[ $key =~ ^[A-Za-z0-9]{16,64}$ ]] || {
    echo "that does not look like an API key (letters and digits only)" >&2
    exit 1
  }
  echo "Read ${#key} characters."
  if ((${#key} != 32)); then
    echo "Note: The Odds API keys are normally 32 characters; check you copied all of it."
  fi
  sed -i "/^#\? \?${VAR}=/d" "$ENV_FILE"
  printf '%s=%s\n' "$VAR" "$key" >>"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  unset key
  entered=true
  echo "Stored $VAR in $ENV_FILE."
fi

cli() {
  docker compose run --rm -T --no-deps -v "$PWD/docs/scraper-plan/data:/in:ro" scraper \
    node dist/cli.js "$@" </dev/null
}

echo "==> Building the api and the scraper (a few minutes)"
docker compose build migrate scraper
docker compose up -d --wait

echo "==> The Odds API's club spellings"
cli aliases import --file /in/aliases-theoddsapi.csv

ok=()
failed=()
for league in "${LEAGUES[@]}"; do
  for source in "theoddsapi-$league" "theoddsapi-scores-$league"; do
    echo
    echo "==> $source: reading the real API once (nothing is written)"
    if cli dry-fetch --source-file "/in/source-$source.json" --limit 3; then
      cli sources upsert --file "/in/source-$source.json"
      ok+=("$source")
    else
      failed+=("$source")
    fi
  done
done

if ((${#ok[@]} == 0)); then
  echo >&2
  echo "Every dry-fetch failed: nothing was added. The lines above say why; HTTP 401 means" >&2
  echo "the key was refused." >&2
  if $entered; then
    sed -i "/^${VAR}=/d" "$ENV_FILE"
    echo "The key you entered was not kept: run this again and paste the whole key." >&2
  fi
  exit 1
fi

echo
echo "Added or updated: ${ok[*]}"
if ((${#failed[@]} > 0)); then
  echo "Skipped, see above: ${failed[*]}"
fi
cat <<'EOF'

In the back office:
 1. Feed: Enable every theoddsapi-* and theoddsapi-scores-* source (sources already enabled
    stay enabled).
 2. Feed, Competitions: for Premier League, Bundesliga, LaLiga, Serie A and Ligue 1 set
    pricing to "market" (bookmaker prices; the model fills in where the market is thin),
    and switch "auto results" on. Leave "extra time" off for these leagues.
 3. From then on a kickoff both sources agree on moves by itself, and a result both agree on
    settles about 15 minutes after the second one reports it. Review shows only real
    disagreements.
EOF
