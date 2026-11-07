#!/usr/bin/env bash
# Read-only report on a compose deployment: why upcoming matches have betting closed (odds locked),
# in plain English, with the competition policies, the sources and the open review queue.
# It changes nothing.
#
#   infra/scripts/feed-report.sh              # the next 7 days
#   infra/scripts/feed-report.sh --days 14    # 1 to 30 days
#   infra/scripts/feed-report.sh --json       # machine-readable
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod
exec docker compose run --rm -T --no-deps scraper node dist/cli.js feed report "$@" </dev/null
