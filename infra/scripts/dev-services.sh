#!/usr/bin/env bash
# Runs PostgreSQL 16 and Redis 7 natively for local development and tests,
# for machines without Docker (e.g. the cloud dev container).
# With Docker, prefer: docker compose -f infra/docker-compose.yml up -d
#
# Usage: infra/scripts/dev-services.sh start|stop|status|reset
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA_DIR="${VAMOS_DATA_DIR:-$REPO_ROOT/.data}"
PGDATA="$DATA_DIR/pg"
REDIS_DIR="$DATA_DIR/redis"
PG_PORT="${PG_PORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"
DB_USER="vamos"
DB_PASSWORD="vamos"

find_pg_bin() {
  if command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v pg_ctl)"
    return
  fi
  local candidate
  for candidate in /usr/lib/postgresql/*/bin; do
    if [[ -x "$candidate/pg_ctl" ]]; then
      echo "$candidate"
      return
    fi
  done
  echo "PostgreSQL server binaries not found (install postgresql-16 or use Docker)" >&2
  exit 1
}

PG_BIN="$(find_pg_bin)"

# PostgreSQL refuses to run as root; drop to the postgres user when needed.
as_pg() {
  if [[ "$(id -u)" == "0" ]]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

pg_running() {
  as_pg "$PG_BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1
}

redis_running() {
  redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1
}

psql_admin() {
  as_pg "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -qtA "$@"
}

start_pg() {
  mkdir -p "$DATA_DIR"
  if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
    echo "initialising PostgreSQL cluster in $PGDATA"
    mkdir -p "$PGDATA"
    if [[ "$(id -u)" == "0" ]]; then chown -R postgres:postgres "$PGDATA"; fi
    chmod 700 "$PGDATA"
    as_pg "$PG_BIN/initdb" -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
  fi
  if pg_running; then
    echo "postgres already running on :$PG_PORT"
  else
    as_pg "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w \
      -o "-p $PG_PORT -k $PGDATA -c listen_addresses=127.0.0.1" start >/dev/null
    echo "postgres started on :$PG_PORT"
  fi
  if [[ "$(psql_admin -c "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'")" != "1" ]]; then
    psql_admin -c "CREATE ROLE $DB_USER LOGIN SUPERUSER PASSWORD '$DB_PASSWORD'"
  fi
  local db
  for db in vamos vamos_test; do
    if [[ "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname='$db'")" != "1" ]]; then
      psql_admin -c "CREATE DATABASE $db OWNER $DB_USER"
      echo "created database $db"
    fi
  done
}

start_redis() {
  if redis_running; then
    echo "redis already running on :$REDIS_PORT"
    return
  fi
  mkdir -p "$REDIS_DIR"
  redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --daemonize yes \
    --dir "$REDIS_DIR" --pidfile "$REDIS_DIR/redis.pid" --logfile "$REDIS_DIR/redis.log" \
    --save "" --appendonly no >/dev/null
  for _ in $(seq 1 50); do
    redis_running && break
    sleep 0.1
  done
  echo "redis started on :$REDIS_PORT"
}

stop_all() {
  if pg_running; then
    as_pg "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null
    echo "postgres stopped"
  fi
  if redis_running; then
    redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
    echo "redis stopped"
  fi
}

status() {
  if pg_running; then echo "postgres: running (:$PG_PORT)"; else echo "postgres: stopped"; fi
  if redis_running; then echo "redis:    running (:$REDIS_PORT)"; else echo "redis:    stopped"; fi
}

case "${1:-}" in
  start)
    start_pg
    start_redis
    echo "DATABASE_URL=postgres://$DB_USER:$DB_PASSWORD@localhost:$PG_PORT/vamos"
    echo "REDIS_URL=redis://localhost:$REDIS_PORT"
    ;;
  stop) stop_all ;;
  status) status ;;
  reset)
    stop_all
    rm -rf "$PGDATA" "$REDIS_DIR"
    echo "local data removed"
    ;;
  *)
    echo "usage: $0 start|stop|status|reset" >&2
    exit 2
    ;;
esac
