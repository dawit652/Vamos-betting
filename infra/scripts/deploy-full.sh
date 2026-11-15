#!/usr/bin/env bash
# Deploys a branch of this repository as the whole stack (the migrate job, api, worker, scraper,
# admin and web) onto a running compose project, keeping that project's env file (and so its
# operating mode), its volumes and its data. Run it inside a git checkout on the server, as root.
#
#   infra/scripts/deploy-full.sh <branch> [env file] [compose project]
#
# On the server, from a checkout that does not have this script yet:
#   cd /opt/nahubet && git fetch origin claude/happy-keller-redesign-v030
#   bash <(git show origin/claude/happy-keller-redesign-v030:infra/scripts/deploy-full.sh) \
#     claude/happy-keller-redesign-v030 /opt/nahubet-new/infra/.env.prod vamos
#
# What it does, stopping at the first problem:
#   1. refuses a checkout with uncommitted changes, or an env file that is not licensed
#      (OPERATING_MODE and NEXT_PUBLIC_OPERATING_MODE must both be `licensed`);
#   2. refuses when the compose file the running project was started with has lines this branch's
#      lacks: settings that exist only on the server, which the deploy would drop (review them,
#      put them in git, or rerun with ALLOW_DROPPED_SETTINGS=1). Lines the branch adds are fine;
#   3. takes a database dump with infra/scripts/backup.sh (BACKUP_DIR, default /root/vamos-backups)
#      and stops if it fails;
#   4. tags the images the running containers use as <image>:before-<timestamp>, the way back;
#   5. checks out origin/<branch> (detached HEAD), builds every image and starts the stack
#      (`up -d --wait`: postgres and redis, then the migrate job, then the services);
#   6. runs scripts/smoke.sh (read-only); if the stack is unhealthy or the smoke test fails, it
#      puts the previous images back and recreates the services from them.
# The migrations it runs stay applied after a rollback. From release v0.2.0 on they only add tables,
# columns and indexes or loosen a rule (0047 to 0052), so the previous images keep working on the
# migrated database; the dump is there for anything else (docs/runbooks/restore-from-backup.md).
set -euo pipefail

BRANCH="${1:?usage: deploy-full.sh <branch> [env file] [compose project]}"
ENV_FILE="${2:-/opt/nahubet-new/infra/.env.prod}"
PROJECT="${3:-vamos}"
SERVICES=(api worker scraper admin web)

# The checkout to build from is the one this is run in (the script may come from the branch being
# deployed, before it is checked out: see the usage above).
cd "$(git rev-parse --show-toplevel)"

[[ -f "$ENV_FILE" ]] || { echo "env file not found: $ENV_FILE" >&2; exit 1; }
for name in OPERATING_MODE NEXT_PUBLIC_OPERATING_MODE; do
  if ! grep -qE "^${name}=licensed$" "$ENV_FILE"; then
    echo "$ENV_FILE does not set ${name}=licensed: refusing to deploy" >&2
    exit 1
  fi
done
if [[ -n "$(git status --porcelain)" ]]; then
  echo "this checkout ($(pwd)) has uncommitted changes: stopping, nothing changed" >&2
  exit 1
fi

git fetch origin "$BRANCH"

# Settings only the server has: lines of the live compose file that this branch's lacks.
LIVE_COMPOSE="$(dirname "$ENV_FILE")/docker-compose.prod.yml"
if [[ -f "$LIVE_COMPOSE" ]]; then
  DROPPED="$(git show "origin/$BRANCH:infra/docker-compose.prod.yml" |
    diff "$LIVE_COMPOSE" - | sed -n 's/^< //p' || true)"
  if [[ -n "$DROPPED" ]]; then
    echo "these lines of $LIVE_COMPOSE are not in origin/$BRANCH and the deploy would drop them:" >&2
    echo "$DROPPED" >&2
    if [[ "${ALLOW_DROPPED_SETTINGS:-0}" != "1" ]]; then
      echo "put them in git first (or review them and rerun with ALLOW_DROPPED_SETTINGS=1). Nothing changed." >&2
      exit 1
    fi
    echo "dropping them (ALLOW_DROPPED_SETTINGS=1)" >&2
  fi
fi

export COMPOSE_FILE=infra/docker-compose.prod.yml
export COMPOSE_ENV_FILES="$ENV_FILE"
export COMPOSE_PROJECT_NAME="$PROJECT"
STAMP="$(date +%Y%m%d-%H%M%S)"

# 3. A database dump before anything changes, with this checkout's backup.sh (it finds the
# repository from its own path, and reads the same COMPOSE_* settings).
export BACKUP_DIR="${BACKUP_DIR:-/root/vamos-backups}"
echo "dumping the database to $BACKUP_DIR ..."
infra/scripts/backup.sh dump

# 4. The way back: the images the running containers use.
declare -A IMAGE BACKUP
for service in "${SERVICES[@]}"; do
  container="${PROJECT}-${service}-1"
  if docker inspect "$container" >/dev/null 2>&1; then
    IMAGE[$service]="$(docker inspect -f '{{.Config.Image}}' "$container")"
    BACKUP[$service]="${IMAGE[$service]%%:*}:before-${STAMP}"
    docker tag "${IMAGE[$service]}" "${BACKUP[$service]}"
    echo "previous $service image saved as ${BACKUP[$service]}"
  fi
done

rollback() {
  echo "deploy failed: putting the previous images back" >&2
  for service in "${!BACKUP[@]}"; do
    docker tag "${BACKUP[$service]}" "${IMAGE[$service]}"
  done
  docker compose up -d --no-build --force-recreate "${!BACKUP[@]}" || true
  echo "the previous images run again; the migrations stay applied (they are additive)." >&2
  echo "database dump of this run: the newest file in $BACKUP_DIR/db" >&2
  exit 1
}

git checkout --detach "origin/$BRANCH"
echo "deploying $(git log -1 --format='%h %s')"

docker compose build
docker compose up -d --wait || rollback

# The smoke test reads the published ports of the env file (the compose defaults otherwise).
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d "'\""; }
HOST="$(env_value BIND_ADDRESS)"
[[ -z "$HOST" || "$HOST" == "0.0.0.0" ]] && HOST=127.0.0.1
API_PORT="$(env_value API_PORT)"
WEB_PORT="$(env_value WEB_PORT)"
ADMIN_PORT="$(env_value ADMIN_PORT)"
WORKER_PORT="$(env_value WORKER_HEALTH_PORT)"
scripts/smoke.sh --production \
  --api "http://$HOST:${API_PORT:-4000}" \
  --web "http://$HOST:${WEB_PORT:-3000}" \
  --admin "http://$HOST:${ADMIN_PORT:-3001}" \
  --worker "http://$HOST:${WORKER_PORT:-4100}" || rollback

echo "done: the whole stack runs $(git log -1 --format='%h'). To go back to the previous images:"
for service in "${!BACKUP[@]}"; do
  echo "  docker tag ${BACKUP[$service]} ${IMAGE[$service]}"
done
echo "  COMPOSE_FILE=$COMPOSE_FILE COMPOSE_ENV_FILES=$ENV_FILE COMPOSE_PROJECT_NAME=$PROJECT docker compose up -d --no-build --force-recreate ${!BACKUP[*]}"
