#!/usr/bin/env bash
# Adds The Odds API (docs/theoddsapi-plan/README.md) as the bookmaker-price source of the five
# top leagues on a compose deployment that already has their fixtures from football-data.org:
#
#   infra/scripts/use-odds-api.sh
#
# 1. Asks for the API key (hidden) unless infra/.env.prod has SCRAPER_SECRET_THEODDSAPI, and
#    stores it there (mode 600, never printed).
# 2. Per league: dry-fetch of the real API once (2 credits each; nothing is written). A league
#    that fails is skipped. A key the API refuses is removed again when it was typed in this run.
# 3. Restarts the scraper with the key and adds the five sources, DISABLED.
# The leagues stay priced by the team-rating model: enable the sources for the shadow run first
# (the plan's P5), and switch a league to market pricing only after it (section 6).
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

ok=()
failed=()
for key in "${LEAGUES[@]}"; do
  echo
  echo "==> theoddsapi-$key: reading the real API once (nothing is written)"
  if cli dry-fetch --source-file "/in/source-theoddsapi-$key.json" --limit 4; then
    ok+=("$key")
  else
    failed+=("$key")
  fi
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
echo "==> Restarting the scraper with the key"
docker compose up -d --wait scraper

for key in "${ok[@]}"; do
  cli sources upsert --file "/in/source-theoddsapi-$key.json"
done

echo
echo "Added (disabled): ${ok[*]/#/theoddsapi-}"
if ((${#failed[@]} > 0)); then
  echo "Skipped, see above: ${failed[*]/#/theoddsapi-}"
fi
cat <<'EOF'

Shadow run (two weeks), in the back office:
 1. Feed: Enable the theoddsapi-* sources. Leave every competition's pricing on "model".
 2. Feed -> Review, kind "unknown team": map each club spelling to the catalogue club (once).
 3. Watch the Feed page: the credit use and any alarm. The odds feed every match's
    bookmaker comparison but players still see the model's prices.
Switch a league's pricing to "market" only after the two weeks (docs/theoddsapi-plan, section 6).
EOF
