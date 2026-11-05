#!/usr/bin/env bash
# Adds football-data.org as the Premier League fixture and result source of a compose deployment
# (docs/scraper-plan/data/source-footballdata-en1.json): official kickoff times, TV moves included,
# and final scores within minutes, where the openfootball file keeps a Saturday 15:00 placeholder
# and adds results days later. Run it on the server, in a terminal (it asks for the key):
#
#   infra/scripts/use-football-data.sh
#
# 1. Asks for the free football-data.org API token (hidden) unless infra/.env.prod has
#    SCRAPER_SECRET_FOOTBALL_DATA already, and stores it there (mode 600, never printed).
# 2. dry-fetch: reads the real API once through the scraper's polite fetcher and prints what it
#    parsed, writing nothing. It stops here if the key, robots.txt or the response shape is wrong.
# 3. Restarts the scraper with the key and adds the source, DISABLED.
# Switching sources and applying the new kickoffs stay a person's decision (back office, Feed).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod
ENV_FILE=infra/.env.prod
VAR=SCRAPER_SECRET_FOOTBALL_DATA
SOURCE=/in/source-footballdata-en1.json

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
  echo "Paste your football-data.org API token (it is not shown) and press Enter:"
  IFS= read -rs token
  echo
  token="${token//[[:space:]]/}"
  [[ $token =~ ^[A-Za-z0-9]{16,64}$ ]] || {
    echo "that does not look like a football-data.org token (letters and digits only)" >&2
    exit 1
  }
  # The input is hidden, so say how much arrived: a token copied short is the usual mistake.
  echo "Read ${#token} characters."
  if ((${#token} != 32)); then
    echo "Note: football-data.org tokens are normally 32 characters; check you copied all of it."
  fi
  sed -i "/^#\? \?${VAR}=/d" "$ENV_FILE"
  printf '%s=%s\n' "$VAR" "$token" >>"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  unset token
  entered=true
  echo "Stored $VAR in $ENV_FILE."
fi

cli() {
  docker compose run --rm -T --no-deps -v "$PWD/docs/scraper-plan/data:/in:ro" scraper \
    node dist/cli.js "$@" </dev/null
}

echo "==> Reading the real API once (nothing is written)"
if ! cli dry-fetch --source-file "$SOURCE" --limit 12; then
  echo >&2
  echo "dry-fetch failed: nothing was changed. The lines above say why; football-data.org" >&2
  echo "answers HTTP 400 to a token it does not accept, and HTTP 403 to one without access." >&2
  if $entered; then
    # Do not keep a token the API refused: the next run asks again.
    sed -i "/^${VAR}=/d" "$ENV_FILE"
    echo "The token you entered was not kept: run this again and paste the whole token." >&2
  else
    echo "To enter another token: sed -i '/^${VAR}=/d' $ENV_FILE, then run this again." >&2
  fi
  exit 1
fi

echo "==> Restarting the scraper with the key"
docker compose up -d --wait scraper

echo "==> Adding the source (it starts disabled)"
cli sources upsert --file "$SOURCE"

cat <<'EOF'

Done. In the back office, in this order:
 1. Feed: Enable footballdata-en1, then Disable openfootball-en1 (its Saturday 15:00 placeholders
    would otherwise keep disagreeing with the real times).
 2. Within about two minutes every match whose time differs gets a "kickoff change" item, and
    betting closes at once on any match that really starts EARLIER than the site says.
 3. Feed -> Review, kind "kickoff change": check each new time and press Apply.
 4. Trading: open betting again on matches that were closed in step 2.
EOF
