#!/usr/bin/env bash
# Restarts the worker of the production compose stack when its health check has said `unhealthy`
# for several runs in a row (docs/plans/worker-standby-design.md, section 3). Docker restarts a
# worker that crashed, but not one that hangs: Compose only marks it unhealthy.
#
# Run it once a minute from a systemd timer or cron on the host, as a user that can use Docker
# (docs/deployment.md, "A worker that hangs"). It restarts nothing but the worker, and a worker
# that is stopped, missing or still starting is left alone (Docker's restart policy and the
# operator own those cases).
#
# Usage: infra/scripts/worker-watchdog.sh
# Environment:
#   COMPOSE_FILE / COMPOSE_ENV_FILES        default infra/docker-compose.prod.yml / infra/.env.prod
#   WATCHDOG_STATE_FILE                     default /run/vamos-worker-watchdog.state
#   WATCHDOG_UNHEALTHY_CHECKS=2             runs in a row that must read `unhealthy` before a restart
#   WATCHDOG_MIN_RESTART_GAP_SECONDS=600    never more than one restart in this time
#
# Alarms are one JSON line on stderr at error level with an `alarm` field, like the application's:
#   worker_restarted        the worker was unhealthy and was restarted
#   worker_restart_failed   the restart command failed (exit 1)
#   worker_unhealthy        unhealthy again within the gap after a restart: not restarted, look at it
# Exit codes: 0 nothing to do or restarted; 1 the restart failed; 2 Docker is not usable.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.prod.yml}"
export COMPOSE_ENV_FILES="${COMPOSE_ENV_FILES:-infra/.env.prod}"
STATE_FILE="${WATCHDOG_STATE_FILE:-/run/vamos-worker-watchdog.state}"
THRESHOLD="${WATCHDOG_UNHEALTHY_CHECKS:-2}"
MIN_GAP="${WATCHDOG_MIN_RESTART_GAP_SECONDS:-600}"
SERVICE=worker

[[ "$THRESHOLD" =~ ^[1-9][0-9]*$ ]] || { echo "WATCHDOG_UNHEALTHY_CHECKS must be a positive integer" >&2; exit 2; }
[[ "$MIN_GAP" =~ ^[0-9]+$ ]] || { echo "WATCHDOG_MIN_RESTART_GAP_SECONDS must be an integer" >&2; exit 2; }
command -v docker >/dev/null || { echo "worker-watchdog: docker is not installed or not on PATH" >&2; exit 2; }

dc() { docker compose "$@"; }
info() { echo "worker-watchdog: $*"; }
# alarm NAME COUNT MESSAGE: one JSON line on stderr (level 50 is pino's `error`).
alarm() {
  printf '{"level":50,"time":%s000,"service":"vamos-worker-watchdog","alarm":"%s","unhealthyChecks":%s,"msg":"%s"}\n' \
    "$(date -u +%s)" "$1" "$2" "$3" >&2
}

# State: "<unhealthy runs in a row> <epoch seconds of the last restart>". Anything else reads as 0 0.
count=0
last=0
if [[ -f "$STATE_FILE" ]]; then
  read -r saved_count saved_last _ <"$STATE_FILE" || true
  [[ "${saved_count:-}" =~ ^[0-9]+$ ]] && count="$saved_count"
  [[ "${saved_last:-}" =~ ^[0-9]+$ ]] && last="$saved_last"
fi
save() {
  local tmp="$STATE_FILE.tmp.$$"
  printf '%s %s\n' "$count" "$last" >"$tmp"
  mv "$tmp" "$STATE_FILE"
}

# Running containers only: a stopped or missing worker is not this script's to start.
id="$(dc ps -q "$SERVICE" 2>/dev/null | head -n 1)" || id=""
if [[ -z "$id" ]]; then
  info "no running $SERVICE container; nothing done"
  exit 0
fi
status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null)" || status=unknown

case "$status" in
  healthy | starting)
    if ((count > 0)); then
      count=0
      save
    fi
    exit 0
    ;;
  unhealthy) count=$((count + 1)) ;;
  *)
    info "health status of $SERVICE is '$status'; nothing done"
    exit 0
    ;;
esac

now="$(date -u +%s)"
if ((count < THRESHOLD)); then
  save
  info "$SERVICE is unhealthy ($count of $THRESHOLD checks); waiting"
  exit 0
fi
if ((now - last < MIN_GAP)); then
  save
  alarm worker_unhealthy "$count" "the worker is unhealthy again $((now - last)) s after a restart; not restarted, look at it"
  exit 0
fi

if dc restart "$SERVICE" >/dev/null; then
  alarm worker_restarted "$count" "the worker was unhealthy for $count checks and was restarted"
  count=0
  last="$now"
  save
  exit 0
fi
save
alarm worker_restart_failed "$count" "the worker is unhealthy and the restart command failed"
exit 1
