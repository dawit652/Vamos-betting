#!/usr/bin/env bash
# Switches a compose deployment (docs/deployment.md section 3) from the simulated feed to real
# Premier League fixtures that the scraper reads from openfootball (docs/scraper-local-test.md).
# Demo mode only. Run it on the server, from anywhere:
#
#   infra/scripts/use-real-fixtures.sh [--reset-database]
#
# --reset-database deletes ALL data first (players, bets, staff accounts, the scraper archive)
# and starts from an empty database. Without it, the matches the simulator already made stay on
# the site, stuck, because nothing plays them out once the simulator is off.
#
# What it does: FEED_PROVIDER=scraped in infra/.env.prod, restarts the stack, loads the demo
# catalogue, adds the openfootball Premier League source and its competition alias, and marks the
# 2026-27 clubs' starting ratings as reviewed. What stays a person's decision, in the back office
# (Feed): enabling the source and the competition, and opening betting on each event.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod
ENV_FILE=infra/.env.prod

reset=false
case "${1:-}" in
  --reset-database) reset=true ;;
  '') ;;
  *)
    echo "usage: $0 [--reset-database]" >&2
    exit 2
    ;;
esac

[[ -f $ENV_FILE ]] || {
  echo "missing $ENV_FILE: run infra/scripts/init-env.sh first" >&2
  exit 1
}
grep -q '^OPERATING_MODE=demo$' "$ENV_FILE" || {
  echo "refusing: $ENV_FILE is not OPERATING_MODE=demo" >&2
  exit 1
}

sed -i 's|^FEED_PROVIDER=.*|FEED_PROVIDER=scraped|' "$ENV_FILE"
grep -q '^FEED_PROVIDER=scraped$' "$ENV_FILE"

if $reset; then
  echo "==> Deleting all data (docker compose down -v)"
  docker compose down -v
fi

echo "==> Starting with FEED_PROVIDER=scraped"
docker compose up -d --wait

echo "==> Demo catalogue"
docker compose run --rm -T migrate node dist/ops/seed.js </dev/null

# The scraper's command line (docs/scraper.md, production); stdin closed so loops keep their input.
cli() {
  docker compose run --rm -T --no-deps -v "$PWD/docs/scraper-plan/data:/in:ro" scraper \
    node dist/cli.js "$@" </dev/null
}

echo "==> Premier League source (starts disabled) and competition alias"
cli sources upsert --file /in/source-openfootball-en1.json
cli aliases import --file /in/aliases-openfootball-en1.csv

echo "==> Team ratings: the catalogue's starting values, marked as reviewed"
while IFS='|' read -r team attack defence; do
  cli ratings set --team "$team" --attack "$attack" --defence "$defence" >/dev/null
  echo "    $team"
done <<'EOF'
Arsenal|1.5|0.68
Aston Villa|1.22|0.95
Bournemouth|1.1|1.02
Brentford|1.1|1.08
Brighton|1.15|1.0
Chelsea|1.35|0.85
Coventry|0.88|1.12
Crystal Palace|1.05|0.95
Everton|0.92|1.0
Fulham|1.02|1.02
Hull|0.82|1.18
Ipswich|0.86|1.14
Leeds|0.9|1.12
Liverpool|1.55|0.75
Man City|1.52|0.78
Man Utd|1.12|1.0
Newcastle|1.25|0.88
Nott'm Forest|1.05|0.95
Sunderland|0.85|1.15
Tottenham|1.2|1.02
EOF

echo
echo "Done. In the back office (Feed): enable the source openfootball-en1 and the competition"
echo "Premier League; within two minutes the real fixtures appear as events with betting closed."
echo "Then Feed -> Review, kind 'odds approval': check each event's prices and press Open betting."
if $reset; then
  echo "The database was emptied: create your admin account again (admin-create, docs/deployment.md)."
fi
