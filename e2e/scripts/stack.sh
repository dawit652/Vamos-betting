#!/usr/bin/env bash
# Starts or stops the stack the e2e suite runs against: the built API, the
# worker with the fast simulator, the production web build (server.mjs:
# next start plus brotli) and the production back-office build (next start).
# Postgres and Redis must already run (pnpm services:start, Docker, or CI
# services), migrated and seeded (pnpm db:migrate && pnpm db:seed).
#
# Usage: e2e/scripts/stack.sh build|start|stop|status
#   build  builds the API, worker, web app and admin app (pnpm build does this too)
#   start  starts the four in the background and waits until they answer
#   stop   stops what `start` started
#
# Logs and pid files go to e2e/.stack/. The fast simulator plays a football
# match in a few seconds and kicks off a rolling fixture every minute; override
# with SIM_SPEED / FEED_ROLLING_EVERY_MINUTES / FEED_ROLLING_HORIZON_MINUTES.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$REPO_ROOT/e2e/.stack"
API_URL="${E2E_API_URL:-http://localhost:4000}"
WEB_URL="${E2E_WEB_URL:-http://localhost:3000}"
ADMIN_URL="${E2E_ADMIN_URL:-http://localhost:3001}"
START_TIMEOUT_S="${E2E_START_TIMEOUT_S:-60}"

export OPERATING_MODE="${OPERATING_MODE:-demo}"
# One absolute ELS report directory for the API (status page) and the worker (writer); the compliance
# spec reads the stream from it. A relative ELS_REPORT_DIR would resolve against each app's own folder.
export ELS_REPORT_DIR="${ELS_REPORT_DIR:-$STATE_DIR/els}"
export SIM_SPEED="${SIM_SPEED:-60}"
export FEED_ROLLING_EVERY_MINUTES="${FEED_ROLLING_EVERY_MINUTES:-1}"
export FEED_ROLLING_HORIZON_MINUTES="${FEED_ROLLING_HORIZON_MINUTES:-10}"
# Phase 11: the SMS and USSD betting channels are off everywhere else; the e2e stack switches them on
# (demo mode, mock aggregators, dev secrets) so channels.spec.ts can drive them through /dev/channels.
export SMS_BETTING_ENABLED="${SMS_BETTING_ENABLED:-true}"
export USSD_ENABLED="${USSD_ENABLED:-true}"
# An older .env may still set the legacy spellings (false); a contradiction is a config error, so agree with it.
export FEATURE_SMS_BETTING="$SMS_BETTING_ENABLED"
export FEATURE_USSD="$USSD_ENABLED"

running() {
  local pidfile="$STATE_DIR/$1.pid"
  [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

launch() {
  local name="$1" dir="$2"
  shift 2
  if running "$name"; then
    echo "$name: already running (pid $(cat "$STATE_DIR/$name.pid"))"
    return
  fi
  # setsid: its own process group, so `stop` also ends the children (next-server).
  (cd "$REPO_ROOT/$dir" && exec setsid "$@" >"$STATE_DIR/$name.log" 2>&1) &
  echo $! >"$STATE_DIR/$name.pid"
  echo "$name: started (pid $!, log e2e/.stack/$name.log)"
}

wait_for() {
  local name="$1" url="$2" deadline=$((SECONDS + START_TIMEOUT_S))
  until curl -sf -o /dev/null "$url"; do
    if ! running "$name"; then
      echo "$name exited; last log lines:" >&2
      tail -n 30 "$STATE_DIR/$name.log" >&2 || true
      exit 1
    fi
    if ((SECONDS > deadline)); then
      echo "$name did not answer at $url within ${START_TIMEOUT_S}s" >&2
      tail -n 30 "$STATE_DIR/$name.log" >&2 || true
      exit 1
    fi
    sleep 1
  done
  echo "$name: ready at $url"
}

stop_one() {
  local name="$1" pidfile="$STATE_DIR/$1.pid"
  if ! running "$name"; then
    rm -f "$pidfile"
    return
  fi
  local pid
  pid="$(cat "$pidfile")"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  rm -f "$pidfile"
  echo "$name: stopped"
}

case "${1:-}" in
  build)
    pnpm --dir "$REPO_ROOT" --filter @vamos/api --filter @vamos/worker --filter @vamos/web --filter @vamos/admin build
    ;;
  start)
    mkdir -p "$STATE_DIR"
    for required in apps/api/dist/server.js apps/worker/dist/main.js apps/web/.next/BUILD_ID apps/admin/.next/BUILD_ID; do
      [[ -e "$REPO_ROOT/$required" ]] || {
        echo "missing $required: run e2e/scripts/stack.sh build first" >&2
        exit 1
      }
    done
    launch api apps/api node dist/server.js
    launch worker apps/worker node dist/main.js
    # server.mjs: next start plus brotli (what production runs; see apps/web/server.mjs).
    launch web apps/web env PORT="${WEB_URL##*:}" node server.mjs
    # The back office (staff UI): next start; it calls the API from the browser.
    launch admin apps/admin env PORT="${ADMIN_URL##*:}" pnpm exec next start --port "${ADMIN_URL##*:}"
    wait_for api "$API_URL/health"
    wait_for web "$WEB_URL/"
    wait_for admin "$ADMIN_URL/login"
    running worker || {
      echo "worker exited:" >&2
      tail -n 30 "$STATE_DIR/worker.log" >&2
      exit 1
    }
    echo "worker: running (SIM_SPEED=$SIM_SPEED, a rolling fixture every $FEED_ROLLING_EVERY_MINUTES min)"
    ;;
  stop)
    stop_one admin
    stop_one web
    stop_one worker
    stop_one api
    ;;
  status)
    for name in api worker web admin; do
      if running "$name"; then echo "$name: running (pid $(cat "$STATE_DIR/$name.pid"))"; else echo "$name: stopped"; fi
    done
    ;;
  *)
    echo "usage: $0 build|start|stop|status" >&2
    exit 2
    ;;
esac
