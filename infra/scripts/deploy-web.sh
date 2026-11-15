#!/usr/bin/env bash
# Deploys only the player web app (the `web` service) from a branch of this repository onto a
# running compose project, keeping that project's env file (and so its operating mode) and every
# other service exactly as they are. Run it inside a git checkout on the server, as root.
#
#   infra/scripts/deploy-web.sh <branch> [env file] [compose project]
#
# On the server, from a checkout that does not have this script yet:
#   cd /opt/nahubet && git fetch origin claude/happy-keller-redesign-merge
#   bash <(git show origin/claude/happy-keller-redesign-merge:infra/scripts/deploy-web.sh) \
#     claude/happy-keller-redesign-merge /opt/nahubet-new/infra/.env.prod vamos
#
# What it does, stopping at the first problem:
#   1. refuses a checkout with uncommitted changes, or an env file that is not a licensed build
#      (NEXT_PUBLIC_OPERATING_MODE=licensed: the web bundle's mode is fixed at build time);
#   2. stops when the compose file differs from the one the running project was started with;
#   3. checks out origin/<branch> (detached HEAD) and tags the image the running web container uses
#      as <image>-before-<timestamp>, the way back;
#   4. builds `web` with the project's env file and recreates only that container (--no-deps);
#   5. checks the new page answers and shows no DEMO banner; if the container is unhealthy or the
#      check fails, it puts the previous image back and recreates the container from it.
# The database, api, worker, admin and scraper are not touched (no migration runs).
set -euo pipefail

BRANCH="${1:?usage: deploy-web.sh <branch> [env file] [compose project]}"
ENV_FILE="${2:-/opt/nahubet-new/infra/.env.prod}"
PROJECT="${3:-vamos}"

# The checkout to build from is the one this is run in (the script itself may come from the branch
# being deployed, before it is checked out: see the usage above).
cd "$(git rev-parse --show-toplevel)"

[[ -f "$ENV_FILE" ]] || { echo "env file not found: $ENV_FILE" >&2; exit 1; }
if ! grep -qE '^NEXT_PUBLIC_OPERATING_MODE=licensed$' "$ENV_FILE"; then
  echo "$ENV_FILE does not set NEXT_PUBLIC_OPERATING_MODE=licensed: refusing to build a demo web app" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "this checkout ($(pwd)) has uncommitted changes: stopping, nothing changed" >&2
  exit 1
fi

git fetch origin "$BRANCH"

# The running project was started from the compose file next to its env file: if that file differs
# from this branch's, recreating `web` could change its ports, networks or settings. Stop and show it
# (set ALLOW_COMPOSE_DIFF=1 after reviewing the difference).
LIVE_COMPOSE="$(dirname "$ENV_FILE")/docker-compose.prod.yml"
if [[ -f "$LIVE_COMPOSE" && "${ALLOW_COMPOSE_DIFF:-0}" != "1" ]]; then
  if ! git show "origin/$BRANCH:infra/docker-compose.prod.yml" 2>/dev/null | diff -u "$LIVE_COMPOSE" - >/tmp/deploy-web-compose.diff; then
    if [[ -s /tmp/deploy-web-compose.diff ]]; then
      cat /tmp/deploy-web-compose.diff >&2
      echo "the compose file differs from $LIVE_COMPOSE (above): review it, then rerun with ALLOW_COMPOSE_DIFF=1" >&2
      exit 1
    fi
  fi
fi

CONTAINER="${PROJECT}-web-1"
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${IMAGE%%:*}:before-${STAMP}"

git checkout --detach "origin/$BRANCH"
echo "deploying web from $(git log -1 --format='%h %s')"

export COMPOSE_FILE=infra/docker-compose.prod.yml
export COMPOSE_ENV_FILES="$ENV_FILE"
export COMPOSE_PROJECT_NAME="$PROJECT"

docker tag "$IMAGE" "$BACKUP"
echo "previous web image saved as $BACKUP"

rollback() {
  echo "deploy failed: putting $BACKUP back" >&2
  docker tag "$BACKUP" "$IMAGE"
  docker compose up -d --no-deps --force-recreate web
  exit 1
}

docker compose build web
docker compose up -d --no-deps --wait web || rollback

# The new page answers and is a licensed build: no DEMO banner (role="note").
if ! docker compose exec -T web node -e '
  fetch("http://localhost:3000/").then((r) => r.text()).then((html) => {
    if (!html.includes("</html>")) throw new Error("no page");
    if (html.includes("role=\"note\"")) throw new Error("the DEMO banner is on the page");
    console.log("web is up: licensed build, no DEMO banner");
  }).catch((e) => { console.error(String(e)); process.exit(1); });
'; then
  rollback
fi

cat <<EOF
done. To go back to the previous web app:
  docker tag $BACKUP $IMAGE
  COMPOSE_FILE=$COMPOSE_FILE COMPOSE_ENV_FILES=$ENV_FILE COMPOSE_PROJECT_NAME=$PROJECT docker compose up -d --no-deps --force-recreate web
EOF
